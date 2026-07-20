// =============================================
// WhatsAppClient.js
// Wrapper de whatsapp-web.js: sesión, QR, grupos
// =============================================

import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const { Client, LocalAuth } = require('whatsapp-web.js')

import qrcode from 'qrcode-terminal'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import 'dotenv/config'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Ruta ABSOLUTA de la sesión — evita problemas según el directorio de ejecución
const SESSION_PATH = process.env.WHATSAPP_SESSION_PATH
  ? path.resolve(process.env.WHATSAPP_SESSION_PATH)
  : path.resolve(__dirname, '..', '.wwebjs_auth')

const SESSION_CLIENT_ID = 'wasapi-grupo'  // ID fijo para localizar siempre la misma sesión
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
        authStrategy: new LocalAuth({
          clientId: SESSION_CLIENT_ID,   // ID fijo → siempre misma carpeta de sesión
          dataPath: SESSION_PATH          // ruta absoluta
        }),
        puppeteer: {
          headless: true,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-extensions'
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

      // Error de auth — sesión corrupta, la limpiamos para pedir QR nuevo
      this.client.on('auth_failure', (msg) => {
        this.status = 'error'
        console.error('❌ Error de autenticación, limpiando sesión corrupta:', msg)
        const sessionFolder = path.join(SESSION_PATH, `session-${SESSION_CLIENT_ID}`)
        try {
          if (fs.existsSync(sessionFolder)) {
            fs.rmSync(sessionFolder, { recursive: true, force: true })
            console.log('🗑️  Sesión corrupta eliminada. Reinicia el servidor para escanear QR nuevo.')
          }
        } catch (_) {}
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
   * Lee directamente window.Store.Chat dentro del navegador en lugar de
   * usar client.getChats(), que falla con el error 'r' cuando el store
   * interno de WhatsApp Web todavia no termino de cargar.
   */
  async getGroups() {
    if (!this.isConnected()) throw new Error('Cliente no conectado')

    const myNumber = this.client.info?.wid?.user
    const page = this.client.pupPage
    if (!page) throw new Error('Pagina de WhatsApp no disponible')

    console.log('Leyendo grupos desde el store de WhatsApp...')

    const groups = await page.evaluate(async (myNum) => {
      // Espera hasta 15s a que window.Store.Chat este disponible y cargado
      for (let i = 0; i < 150; i++) {
        if (window.Store && window.Store.Chat && window.Store.Chat.getModelsArray) {
          const models = window.Store.Chat.getModelsArray()
          if (models.length > 0) {
            return models
              .filter(function(chat) { return chat.isGroup })
              .map(function(chat) {
                var parts = []
                try { parts = chat.groupMetadata.participants.getModelsArray() } catch(_) {}
                var isAdmin = parts.some(function(p) {
                  return p.id && p.id.user === myNum && (p.isAdmin || p.isSuperAdmin)
                })
                return {
                  id: chat.id ? chat.id._serialized : '',
                  name: chat.name || chat.formattedTitle || 'Sin nombre',
                  participantCount: parts.length,
                  isAdmin: isAdmin
                }
              })
              .filter(function(g) { return g.id !== '' })
          }
        }
        await new Promise(function(r) { setTimeout(r, 100) })
      }
      throw new Error('Store de chats no disponible despues de 15s')
    }, myNumber)

    console.log(groups.length + ' grupo(s) encontrado(s)')
    return groups
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
