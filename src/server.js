// =============================================
// server.js — Servidor Express
// API REST para gestión de grupos de WhatsApp
// =============================================

import express from 'express'
import cors from 'cors'
import multer from 'multer'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { networkInterfaces } from 'os'
import 'dotenv/config'

import { whatsappClient } from './WhatsAppClient.js'
import { readPhonesFromExcel, getExcelHeaders } from './excelReader.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads')

// Crear carpeta de uploads si no existe
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true })

// Configurar multer para guardar el Excel temporalmente
const upload = multer({
  dest: UPLOADS_DIR,
  fileFilter: (_req, file, cb) => {
    const allowed = ['.xlsx', '.xls']
    const ext = path.extname(file.originalname).toLowerCase()
    if (allowed.includes(ext)) return cb(null, true)
    cb(new Error('Solo se permiten archivos .xlsx o .xls'))
  },
  limits: { fileSize: 10 * 1024 * 1024 } // 10 MB máximo
})

const app = express()
app.use(cors())
app.use(express.json())

// ── Middleware de logging básico ──────────────────────────────
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`)
  next()
})

// ─────────────────────────────────────────────────────────────
// GET /status
// Estado del cliente de WhatsApp
// ─────────────────────────────────────────────────────────────
app.get('/status', (_req, res) => {
  res.json({
    success: true,
    status: whatsappClient.status,
    connected: whatsappClient.isConnected(),
    qr_available: !!whatsappClient.qrCode
  })
})

// ─────────────────────────────────────────────────────────────
// GET /qr
// Obtiene el QR actual (base64 text) para conectar WhatsApp
// ─────────────────────────────────────────────────────────────
app.get('/qr', (_req, res) => {
  if (whatsappClient.isConnected()) {
    return res.json({ success: true, status: 'connected', message: 'Ya conectado, no se necesita QR' })
  }
  if (!whatsappClient.qrCode) {
    return res.status(404).json({ success: false, error: 'QR no disponible todavía. Espera unos segundos.' })
  }
  res.json({ success: true, qr: whatsappClient.qrCode })
})

// ─────────────────────────────────────────────────────────────
// GET /grupos
// Lista todos los grupos de WhatsApp del cliente conectado
// ─────────────────────────────────────────────────────────────
app.get('/grupos', async (_req, res) => {
  try {
    if (!whatsappClient.isConnected()) {
      return res.status(503).json({ success: false, error: 'WhatsApp no está conectado' })
    }

    const groups = await whatsappClient.getGroups()

    res.json({
      success: true,
      total: groups.length,
      grupos: groups
    })
  } catch (err) {
    console.error('Error listando grupos:', err)
    res.status(500).json({ success: false, error: err.message })
  }
})

// ─────────────────────────────────────────────────────────────
// POST /grupos/:groupId/agregar
// Agrega números enviados como JSON a un grupo
// Body: { "phones": ["51987654321", "51912345678"] }
// ─────────────────────────────────────────────────────────────
app.post('/grupos/:groupId/agregar', async (req, res) => {
  try {
    if (!whatsappClient.isConnected()) {
      return res.status(503).json({ success: false, error: 'WhatsApp no está conectado' })
    }

    const { groupId } = req.params
    const { phones } = req.body

    if (!phones || !Array.isArray(phones) || phones.length === 0) {
      return res.status(400).json({ success: false, error: 'Se requiere un array "phones" con al menos un número' })
    }

    console.log(`\n▶ Agregando ${phones.length} contacto(s) al grupo ${groupId}...`)
    const result = await whatsappClient.addParticipantsToGroup(groupId, phones)

    res.json({
      success: true,
      grupo_id: groupId,
      total_procesados: phones.length,
      agregados: result.added.length,
      fallidos: result.failed.length,
      resultados: {
        agregados: result.added,
        fallidos: result.failed
      }
    })
  } catch (err) {
    console.error('Error agregando participantes:', err)
    res.status(500).json({ success: false, error: err.message })
  }
})

// ─────────────────────────────────────────────────────────────
// POST /grupos/:groupId/agregar-excel
// Sube un archivo Excel, extrae los teléfonos y los agrega al grupo
//
// Form-data:
//   - file: el archivo .xlsx / .xls
//   - column (opcional): nombre de la columna de teléfonos
// ─────────────────────────────────────────────────────────────
app.post('/grupos/:groupId/agregar-excel', upload.any(), async (req, res) => {
  // Aceptar cualquier nombre de campo para el archivo
  if (req.files?.length > 0) {
    req.file = req.files[0]
  }
  const tempFile = req.file?.path

  try {
    if (!whatsappClient.isConnected()) {
      return res.status(503).json({ success: false, error: 'WhatsApp no está conectado' })
    }

    if (!req.file) {
      return res.status(400).json({ success: false, error: 'Se requiere un archivo Excel (.xlsx / .xls)' })
    }

    const { groupId } = req.params
    const columnName = req.body?.column || null

    // 1. Leer teléfonos del Excel
    const { phones, columnUsed, totalRows, skipped } = readPhonesFromExcel(tempFile, columnName)

    if (phones.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No se encontraron números en el Excel',
        columna_usada: columnUsed,
        total_filas: totalRows
      })
    }

    console.log(`\n▶ Excel: ${phones.length} números leídos (columna: "${columnUsed}"), agregando al grupo ${groupId}...`)

    // 2. Agregar al grupo
    const result = await whatsappClient.addParticipantsToGroup(groupId, phones)

    // 3. Limpiar archivo temporal
    fs.unlinkSync(tempFile)

    res.json({
      success: true,
      grupo_id: groupId,
      archivo: req.file.originalname,
      columna_usada: columnUsed,
      excel_filas: totalRows,
      excel_vacias: skipped,
      numeros_leidos: phones.length,
      agregados: result.added.length,
      fallidos: result.failed.length,
      resultados: {
        agregados: result.added,
        fallidos: result.failed
      }
    })
  } catch (err) {
    console.error('Error procesando Excel:', err)
    // Limpiar archivo temporal si hubo error
    if (tempFile && fs.existsSync(tempFile)) fs.unlinkSync(tempFile)
    res.status(500).json({ success: false, error: err.message })
  }
})

// ─────────────────────────────────────────────────────────────
// POST /grupos/:groupId/inspeccionar-excel
// Solo lee el Excel y retorna los encabezados y una preview
// Útil para saber qué columna elegir antes de agregar
// ─────────────────────────────────────────────────────────────
app.post('/grupos/:groupId/inspeccionar-excel', upload.any(), async (req, res) => {
  if (req.files?.length > 0) {
    req.file = req.files[0]
  }
  const tempFile = req.file?.path

  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'Se requiere un archivo Excel' })
    }

    const headers = getExcelHeaders(tempFile)
    const { phones, columnUsed, totalRows, skipped } = readPhonesFromExcel(tempFile)

    fs.unlinkSync(tempFile)

    res.json({
      success: true,
      archivo: req.file.originalname,
      columnas_disponibles: headers,
      columna_detectada: columnUsed,
      total_filas: totalRows,
      filas_vacias: skipped,
      numeros_encontrados: phones.length,
      preview: phones.slice(0, 10) // Primeros 10 números como muestra
    })
  } catch (err) {
    if (tempFile && fs.existsSync(tempFile)) fs.unlinkSync(tempFile)
    res.status(500).json({ success: false, error: err.message })
  }
})

// ─────────────────────────────────────────────────────────────
// Arranque del servidor y del cliente de WhatsApp
// ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3030

// Obtener IP local (prioriza interfaces reales sobre virtuales)
function getLocalIP() {
  const nets = networkInterfaces()
  const results = []

  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        results.push({ name, address: net.address })
      }
    }
  }

  // Excluir interfaces virtuales/VPN
  const excluded = ['virtual', 'vbox', 'docker', 'warp', 'cloudflare', 'vethernet', 'default switch', 'bluetooth']
  const filtered = results.filter(r =>
    !excluded.some(ex => r.name.toLowerCase().includes(ex))
  )

  // Priorizar IPs de redes locales reales (192.168.x.x con gateway)
  const localNet = filtered.find(r => r.address.startsWith('192.168.'))
  if (localNet) return localNet.address

  // Priorizar otras redes privadas
  const privateNet = filtered.find(r =>
    r.address.startsWith('10.') || r.address.startsWith('172.')
  )
  if (privateNet) return privateNet.address

  return filtered[0]?.address || results[0]?.address || 'localhost'
}

const LOCAL_IP = getLocalIP()

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`\n🚀 Servidor corriendo en:`)
  console.log(`   Local:   http://localhost:${PORT}`)
  console.log(`   Red:     http://${LOCAL_IP}:${PORT}`)
  console.log('─'.repeat(50))
  console.log('📋 Endpoints disponibles:')
  console.log(`  GET  http://${LOCAL_IP}:${PORT}/status`)
  console.log(`  GET  http://${LOCAL_IP}:${PORT}/qr`)
  console.log(`  GET  http://${LOCAL_IP}:${PORT}/grupos`)
  console.log(`  POST http://${LOCAL_IP}:${PORT}/grupos/:groupId/agregar`)
  console.log(`  POST http://${LOCAL_IP}:${PORT}/grupos/:groupId/agregar-excel`)
  console.log(`  POST http://${LOCAL_IP}:${PORT}/grupos/:groupId/inspeccionar-excel`)
  console.log('─'.repeat(50))
  console.log('\n⏳ Iniciando WhatsApp... (puede tomar unos segundos)\n')

  try {
    await whatsappClient.initialize()
  } catch (err) {
    console.error('❌ Error iniciando WhatsApp:', err.message)
    console.log('   Reinicia el servidor para intentar de nuevo.')
  }
})


// ─────────────────────────────────────────────────────────────
// Cierre limpio del servidor
// ─────────────────────────────────────────────────────────────
let isShuttingDown = false

async function shutdown(signal) {
  if (isShuttingDown) return
  isShuttingDown = true

  console.log(`\n🛑 Señal ${signal} recibida — cerrando servidor...`)

  // Forzar salida en 6s si algo cuelga (ej: Chrome zombie en Windows)
  const forceExit = setTimeout(() => {
    console.log('⚠️  Cierre forzado (timeout de 6s)')
    process.exit(0)
  }, 6000)
  forceExit.unref() // No impedir que el proceso termine normalmente

  try {
    await whatsappClient.destroy()
    console.log('✅ WhatsApp cerrado correctamente')
  } catch (err) {
    // Ignorar errores al cerrar (procesos Chrome ya muertos en Windows)
  }

  clearTimeout(forceExit)
  process.exit(0)
}

process.on('SIGINT',  () => shutdown('SIGINT'))   // Ctrl+C
process.on('SIGTERM', () => shutdown('SIGTERM'))  // kill / systemd
