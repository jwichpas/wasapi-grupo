// =============================================
// WhatsAppClient.js
// Wrapper de whatsapp-web.js: sesión, QR, grupos
// =============================================

import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const { Client, LocalAuth } = require('whatsapp-web.js')

import qrcode from 'qrcode-terminal'
import fs from 'fs'
import 'dotenv/config'

const SESSION_PATH = process.env.WHATSAPP_SESSION_PATH || './.wwebjs_auth'
const DEFAULT_COUNTRY = process.env.DEFAULT_COUNTRY_CODE || '51'

// Delay entre cada participante agregado para evitar bloqueos
const ADD_DELAY_MS = 1500

/**
 * Normaliza un número de teléfono al formato requerido por WhatsApp (ej: 51987654321)
 * - Elimina espacios, guiones, paréntesis y el signo +
 * - Si no tiene código de país, agrega el DEFAULT_COUNTRY_CODE
 */
function normalizePhone(raw) {
  if (!raw) return null

  // Convertir a string y limpiar caracteres no numéricos
  let phone = String(raw).replace(/[\s\-\(\)\+\.]/g, '').trim()

  // Si quedó vacío o no son dígitos, descartar
  if (!/^\d+$/.test(phone)) return null

  // Si empieza con 0, quitarlo (algunos números locales tienen 0 al inicio)
  if (phone.startsWith('0')) phone = phone.slice(1)

  // Si el número ya tiene 11+ dígitos asumimos que ya tiene código de país
  if (phone.length >= 11) return phone

  // Si tiene 9 dígitos (número local peruano / similar), agregar código de país
  if (phone.length >= 7) return `${DEFAULT_COUNTRY}${phone}`

  return null // Demasiado corto, descartar
}

export class WhatsAppClient {
  constructor() {
    this.client = null
    this.status = 'disconnected'
    this.qrCode = null
    this.onQRCallback = null
    this.onReadyCallback = null
  }

  /**
   * Inicializa el cliente de WhatsApp y espera a que esté listo
   * Resuelve la promesa cuando la sesión está conectada
   */
  async initialize() {
    return new Promise((resolve, reject) => {
      this.client = new Client({
        authStrategy: new LocalAuth({ dataPath: SESSION_PATH }),
        puppeteer: {
          headless: true,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu'
          ]
        }
      })

      // QR generado — mostrarlo en terminal y guardarlo
      this.client.on('qr', (qr) => {
        this.qrCode = qr
        this.status = 'qr_pending'
        console.log('\n📱 Escanea este QR con tu WhatsApp:\n')
        qrcode.generate(qr, { small: true })
        if (this.onQRCallback) this.onQRCallback(qr)
      })

      // Autenticado (QR escaneado)
      this.client.on('authenticated', () => {
        this.status = 'connecting'
        this.qrCode = null
        console.log('✅ WhatsApp autenticado — cargando sesión...')
      })

      // Listo para usar
      this.client.on('ready', () => {
        this.status = 'connected'
        this.qrCode = null
        const info = this.client.info
        console.log(`✅ WhatsApp listo! Número: ${info?.wid?.user || 'desconocido'}`)
        // Registrar cuándo estuvo listo (getChats necesita unos segundos más)
        this.readyAt = Date.now()
        if (this.onReadyCallback) this.onReadyCallback()
        resolve(this)
      })

      // Error de auth
      this.client.on('auth_failure', (msg) => {
        this.status = 'error'
        console.error('❌ Error de autenticación:', msg)
        reject(new Error(`Auth failure: ${msg}`))
      })

      // Desconectado
      this.client.on('disconnected', (reason) => {
        this.status = 'disconnected'
        console.warn('⚠️  WhatsApp desconectado:', reason)
      })

      this.client.initialize()
    })
  }

  /**
   * Retorna true si el cliente está conectado
   */
  isConnected() {
    return this.status === 'connected' && this.client !== null
  }

  /**
   * Obtiene todos los grupos donde el cliente es miembro.
   * Incluye reintentos porque getChats() puede fallar si se llama
   * muy pronto después del evento 'ready' (WhatsApp Web aún carga chats).
   * @param {number} maxRetries - Número máximo de reintentos
   * @returns {Promise<Array<{id: string, name: string, participantCount: number, isAdmin: boolean}>>}
   */
  async getGroups(maxRetries = 3) {
    if (!this.isConnected()) throw new Error('Cliente no conectado')

    // Si recién conectó, esperar al menos 5s antes de llamar getChats()
    const msSinceReady = this.readyAt ? Date.now() - this.readyAt : Infinity
    if (msSinceReady < 5000) {
      const wait = 5000 - msSinceReady
      console.log(`⏳ Esperando ${Math.round(wait / 1000)}s para que WhatsApp termine de cargar chats...`)
      await new Promise(r => setTimeout(r, wait))
    }

    let lastError
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const chats = await this.client.getChats()
        const myNumber = this.client.info?.wid?.user

        return chats
          .filter(chat => chat.isGroup)
          .map(chat => {
            const isAdmin = chat.groupMetadata?.participants?.some(
              p => p.id.user === myNumber && (p.isAdmin || p.isSuperAdmin)
            ) ?? false

            return {
              id: chat.id._serialized,   // ej: 123456789@g.us
              name: chat.name,
              participantCount: chat.groupMetadata?.participants?.length ?? 0,
              isAdmin
            }
          })
      } catch (err) {
        lastError = err
        console.warn(`⚠️  getChats() fallo en intento ${attempt}/${maxRetries}: ${err.message}`)
        if (attempt < maxRetries) {
          const delay = attempt * 3000 // 3s, 6s...
          console.log(`   Reintentando en ${delay / 1000}s...`)
          await new Promise(r => setTimeout(r, delay))
        }
      }
    }

    throw new Error(`No se pudo obtener los grupos tras ${maxRetries} intentos: ${lastError?.message}`)
  }

  /**
   * Agrega un array de números de teléfono a un grupo de WhatsApp
   * @param {string} groupId  - ID del grupo (formato: 123456789@g.us)
   * @param {string[]} phones - Array de teléfonos normalizados (con código de país)
   * @returns {Promise<{added: string[], failed: Array<{phone: string, reason: string}>}>}
   */
  async addParticipantsToGroup(groupId, phones) {
    if (!this.isConnected()) throw new Error('Cliente no conectado')

    const chat = await this.client.getChatById(groupId)
    if (!chat || !chat.isGroup) throw new Error(`Grupo no encontrado: ${groupId}`)

    const added = []
    const failed = []

    for (const rawPhone of phones) {
      const phone = normalizePhone(rawPhone)

      if (!phone) {
        failed.push({ phone: String(rawPhone), reason: 'numero_invalido' })
        continue
      }

      const participantId = `${phone}@c.us`

      try {
        // Verificar si ya es participante del grupo
        const alreadyIn = chat.groupMetadata?.participants?.some(
          p => p.id.user === phone
        )

        if (alreadyIn) {
          failed.push({ phone, reason: 'ya_es_miembro' })
          continue
        }

        await chat.addParticipants([participantId])
        added.push(phone)
        console.log(`  ✅ Agregado: ${phone}`)
      } catch (err) {
        const reason = err.message?.includes('privacy') ? 'privacidad_bloqueada'
          : err.message?.includes('not a contact') ? 'no_es_contacto'
          : err.message || 'error_desconocido'

        failed.push({ phone, reason })
        console.warn(`  ⚠️  Fallo ${phone}: ${reason}`)
      }

      // Delay entre cada add para no spamear
      await new Promise(r => setTimeout(r, ADD_DELAY_MS))
    }

    return { added, failed }
  }

  /**
   * Destruye el cliente liberando recursos
   */
  async destroy() {
    if (this.client) {
      await this.client.destroy().catch(() => {})
      this.client = null
      this.status = 'disconnected'
    }
  }
}

// Instancia singleton
export const whatsappClient = new WhatsAppClient()
