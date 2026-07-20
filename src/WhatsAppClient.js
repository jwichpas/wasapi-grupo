// =============================================
// WhatsAppClient.js
// Wrapper de Baileys: sesión, QR, grupos
// =============================================

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys'

import qrcode from 'qrcode-terminal'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import pino from 'pino'
import 'dotenv/config'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Ruta de la sesión
const SESSION_PATH = process.env.WHATSAPP_SESSION_PATH
  ? path.resolve(process.env.WHATSAPP_SESSION_PATH)
  : path.resolve(__dirname, '..', '.wwebjs_auth')

const DEFAULT_COUNTRY = process.env.DEFAULT_COUNTRY_CODE || '51'

// Delay entre cada participante agregado para evitar bloqueos
const ADD_DELAY_MS = 4000  // 4 segundos entre cada uno
const ADD_BATCH_SIZE = 3   // Cada 3 agregados, hacer pausa larga
const ADD_BATCH_DELAY_MS = 30000  // 30 segundos de pausa cada batch
const RATE_LIMIT_DELAY_MS = 120000  // 2 minutos si detectamos rate-limit

// Logger silencioso para Baileys
const logger = pino({ level: 'silent' })

/**
 * Normaliza un número de teléfono al formato requerido por WhatsApp
 */
function normalizePhone(raw) {
  if (!raw) return null

  let phone = String(raw).replace(/[\s\-\(\)\+\.]/g, '').trim()
  if (!/^\d+$/.test(phone)) return null
  if (phone.startsWith('0')) phone = phone.slice(1)
  if (phone.length >= 11) return phone
  if (phone.length >= 7) return `${DEFAULT_COUNTRY}${phone}`

  return null
}

export class WhatsAppClient {
  constructor() {
    this.sock = null
    this.status = 'disconnected'
    this.qrCode = null
    this.phoneNumber = null
    this.onQRCallback = null
    this.onReadyCallback = null
  }

  /**
   * Inicializa el cliente de WhatsApp
   */
  async initialize() {
    // Crear carpeta de sesión si no existe
    if (!fs.existsSync(SESSION_PATH)) {
      fs.mkdirSync(SESSION_PATH, { recursive: true })
    }

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH)
    const { version } = await fetchLatestBaileysVersion()

    console.log(`📱 Usando Baileys v${version.join('.')}`)

    this.sock = makeWASocket({
      version,
      auth: state,
      logger,
      printQRInTerminal: false,
      browser: ['wasapi-grupo', 'Chrome', '120.0.0'],
      syncFullHistory: false,
      markOnlineOnConnect: false
    })

    // Manejar actualizaciones de conexión
    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update

      if (qr) {
        this.qrCode = qr
        this.status = 'qr_pending'
        console.log('\n📱 Escanea este QR con tu WhatsApp:\n')
        qrcode.generate(qr, { small: true })
        if (this.onQRCallback) this.onQRCallback(qr)
      }

      if (connection === 'close') {
        const reason = lastDisconnect?.error?.output?.statusCode
        const shouldReconnect = reason !== DisconnectReason.loggedOut

        console.log(`⚠️ Conexión cerrada: ${reason}`)

        if (shouldReconnect) {
          console.log('🔄 Reconectando...')
          setTimeout(() => this.initialize(), 3000)
        } else {
          this.status = 'disconnected'
          console.log('❌ Sesión cerrada. Borra la carpeta de sesión para reconectar.')
        }
      }

      if (connection === 'open') {
        this.status = 'connected'
        this.qrCode = null
        this.phoneNumber = this.sock.user?.id?.split(':')[0] || 'desconocido'
        console.log(`✅ WhatsApp listo! Número: ${this.phoneNumber}`)
        if (this.onReadyCallback) this.onReadyCallback()
      }
    })

    // Guardar credenciales cuando se actualicen
    this.sock.ev.on('creds.update', saveCreds)

    return this
  }

  /**
   * Retorna true si el cliente está conectado
   */
  isConnected() {
    return this.status === 'connected' && this.sock !== null
  }

  /**
   * Obtiene todos los grupos donde el cliente es miembro
   */
  async getGroups() {
    if (!this.isConnected()) throw new Error('Cliente no conectado')

    console.log('Leyendo grupos...')

    // Obtener todos los grupos
    const groups = await this.sock.groupFetchAllParticipating()
    const myJid = this.sock.user?.id

    const result = []

    for (const [id, metadata] of Object.entries(groups)) {
      const participants = metadata.participants || []
      const me = participants.find(p => p.id.includes(this.phoneNumber))
      const isAdmin = me?.admin === 'admin' || me?.admin === 'superadmin'

      result.push({
        id: id,
        name: metadata.subject || 'Sin nombre',
        participantCount: participants.length,
        isAdmin
      })
    }

    console.log(`${result.length} grupo(s) encontrado(s)`)
    return result
  }

  /**
   * Agrega participantes a un grupo
   */
  async addParticipantsToGroup(groupId, phones) {
    if (!this.isConnected()) throw new Error('Cliente no conectado')

    const added = []
    const failed = []

    // Verificar que el grupo existe y obtener participantes actuales
    let groupMetadata
    try {
      groupMetadata = await this.sock.groupMetadata(groupId)
    } catch (err) {
      throw new Error(`Grupo no encontrado: ${groupId}`)
    }

    const currentParticipants = new Set(
      groupMetadata.participants.map(p => p.id.split('@')[0])
    )

    for (const rawPhone of phones) {
      const phone = normalizePhone(rawPhone)

      if (!phone) {
        failed.push({ phone: String(rawPhone), reason: 'numero_invalido' })
        continue
      }

      // Verificar si ya es miembro
      if (currentParticipants.has(phone)) {
        failed.push({ phone, reason: 'ya_es_miembro' })
        continue
      }

      const jid = `${phone}@s.whatsapp.net`

      try {
        // Verificar si el número existe en WhatsApp
        const [exists] = await this.sock.onWhatsApp(jid)

        if (!exists?.exists) {
          failed.push({ phone, reason: 'no_es_contacto' })
          continue
        }

        // Agregar al grupo
        const response = await this.sock.groupParticipantsUpdate(groupId, [jid], 'add')

        const status = response?.[0]?.status || response?.[0]?.content?.content?.[0]?.attrs?.code

        if (status === '200' || status === 200 || !status) {
          added.push(phone)
          console.log(`  ✅ Agregado: ${phone}`)
          currentParticipants.add(phone)
        } else if (status === '403') {
          failed.push({ phone, reason: 'privacidad_bloqueada' })
          console.warn(`  ⚠️ Fallo ${phone}: privacidad_bloqueada`)
        } else if (status === '409') {
          failed.push({ phone, reason: 'ya_es_miembro' })
          console.warn(`  ⚠️ Fallo ${phone}: ya_es_miembro`)
        } else {
          const statusStr = String(status)
          // Detectar rate-limit
          if (statusStr.includes('rate') || statusStr.includes('limit') || statusStr === '429') {
            console.warn(`  🚫 Rate-limit detectado! Pausando ${RATE_LIMIT_DELAY_MS / 1000}s...`)
            failed.push({ phone, reason: 'rate_limit' })
            await new Promise(r => setTimeout(r, RATE_LIMIT_DELAY_MS))
          } else {
            failed.push({ phone, reason: `error_${status}` })
            console.warn(`  ⚠️ Fallo ${phone}: error_${status}`)
          }
        }
      } catch (err) {
        const errMsg = err.message || ''

        // Detectar rate-limit en excepciones
        if (errMsg.includes('rate') || errMsg.includes('limit') || errMsg.includes('overlimit')) {
          console.warn(`  🚫 Rate-limit detectado! Pausando ${RATE_LIMIT_DELAY_MS / 1000}s...`)
          failed.push({ phone, reason: 'rate_limit' })
          await new Promise(r => setTimeout(r, RATE_LIMIT_DELAY_MS))
          continue
        }

        const reason = errMsg.includes('privacy') ? 'privacidad_bloqueada'
          : errMsg.includes('not-authorized') ? 'no_autorizado'
          : errMsg || 'error_desconocido'

        failed.push({ phone, reason })
        console.warn(`  ⚠️ Fallo ${phone}: ${reason}`)
      }

      // Delay entre cada add para no spamear
      await new Promise(r => setTimeout(r, ADD_DELAY_MS))

      // Pausa larga cada batch para evitar rate-limit
      const totalProcessed = added.length + failed.length
      if (totalProcessed > 0 && totalProcessed % ADD_BATCH_SIZE === 0) {
        console.log(`  ⏸️ Pausa de ${ADD_BATCH_DELAY_MS / 1000}s después de ${totalProcessed} procesados...`)
        await new Promise(r => setTimeout(r, ADD_BATCH_DELAY_MS))
      }
    }

    return { added, failed }
  }

  /**
   * Destruye el cliente liberando recursos
   */
  async destroy() {
    if (this.sock) {
      try {
        await this.sock.logout()
      } catch (_) {}

      this.sock.end()
      this.sock = null
      this.status = 'disconnected'
    }
  }
}

// Instancia singleton
export const whatsappClient = new WhatsAppClient()
