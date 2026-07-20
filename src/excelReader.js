// =============================================
// excelReader.js
// Lee un archivo Excel y extrae los números de teléfono
// =============================================

import XLSX from 'xlsx'

// Nombres de columna que se reconocen como columna de teléfono
const PHONE_COLUMN_KEYWORDS = ['telefono', 'teléfono', 'phone', 'celular', 'numero', 'número', 'whatsapp', 'movil', 'móvil', 'tel']

/**
 * Detecta cuál columna del Excel contiene los números de teléfono
 * @param {string[]} headers - Encabezados de la primera fila del Excel
 * @returns {string|null} - Nombre de la columna encontrada o null
 */
function detectPhoneColumn(headers) {
  const normalized = headers.map(h => String(h).toLowerCase().trim())

  for (const keyword of PHONE_COLUMN_KEYWORDS) {
    const idx = normalized.findIndex(h => h.includes(keyword))
    if (idx !== -1) return headers[idx]
  }

  return null // No se encontró columna de teléfono
}

/**
 * Lee un archivo Excel y retorna los números de teléfono encontrados
 * @param {string} filePath - Ruta absoluta al archivo Excel (.xlsx / .xls)
 * @param {string|null} columnName - Nombre de columna a usar (null = autodetectar)
 * @returns {{
 *   phones: string[],
 *   columnUsed: string,
 *   totalRows: number,
 *   skipped: number
 * }}
 */
export function readPhonesFromExcel(filePath, columnName = null) {
  const workbook = XLSX.readFile(filePath)
  const sheetName = workbook.SheetNames[0]
  const sheet = workbook.Sheets[sheetName]

  // Convertir la hoja a JSON (primera fila como headers)
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' })

  if (rows.length === 0) {
    return { phones: [], columnUsed: null, totalRows: 0, skipped: 0 }
  }

  // Detectar la columna de teléfono
  const headers = Object.keys(rows[0])
  const col = columnName || detectPhoneColumn(headers) || headers[0]

  const phones = []
  let skipped = 0

  for (const row of rows) {
    const rawValue = row[col]
    if (rawValue === '' || rawValue === null || rawValue === undefined) {
      skipped++
      continue
    }
    phones.push(String(rawValue).trim())
  }

  return {
    phones,
    columnUsed: col,
    totalRows: rows.length,
    skipped
  }
}

/**
 * Retorna todos los encabezados de la primera hoja del Excel
 * Útil para que el cliente elija la columna correcta
 * @param {string} filePath
 * @returns {string[]}
 */
export function getExcelHeaders(filePath) {
  const workbook = XLSX.readFile(filePath)
  const sheetName = workbook.SheetNames[0]
  const sheet = workbook.Sheets[sheetName]
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' })
  return rows.length > 0 ? Object.keys(rows[0]) : []
}
