import type {
  Category,
  ImportColumnMapping,
  ImportPreview,
  PreviewRow,
  TransactionSource,
  TransactionType,
} from '../types'

export interface RawImportTable {
  fileName: string
  fileHash: string
  headers: string[]
  rows: string[][]
}

const normalizeHeader = (value: string): string =>
  value.toLocaleLowerCase('de-DE').replace(/[ä]/g, 'a').replace(/[ö]/g, 'o').replace(/[ü]/g, 'u').replace(/[^a-z0-9]/g, '')

const findHeader = (headers: string[], terms: string[]): string | undefined =>
  headers.find((header) => terms.some((term) => normalizeHeader(header).includes(term)))

export function suggestMapping(headers: string[]): ImportColumnMapping {
  const eurAmount = findHeader(headers, ['eurbetrag', 'betragineur', 'eurobetrag', 'convertedamounteur'])
  const originalAmountHeaders = eurAmount ? headers.filter((header) => header !== eurAmount) : headers
  return {
    date: findHeader(headers, ['datum', 'date', 'buchungstag', 'valuta']) ?? headers[0] ?? '',
    amount: findHeader(originalAmountHeaders, ['betrag', 'amount', 'netto', 'umsatz']) ?? originalAmountHeaders[1] ?? '',
    debit: findHeader(headers, ['soll', 'debit', 'belastung']),
    credit: findHeader(headers, ['haben', 'credit', 'gutschrift']),
    currency: findHeader(headers, ['wahrung', 'currency', 'waehrung']),
    eurAmount,
    merchant: findHeader(headers, ['empfanger', 'handler', 'merchant', 'name', 'gegenpartei']),
    description: findHeader(headers, ['verwendungszweck', 'beschreibung', 'description', 'betreff', 'typ']) ?? headers[2] ?? '',
    externalId: findHeader(headers, ['transaktionscode', 'transaktionsid', 'transactionid', 'referenz', 'reference', 'id']),
  }
}

export function parseDelimitedText(text: string): { headers: string[]; rows: string[][] } {
  const cleanText = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const firstLine = cleanText.split('\n')[0] ?? ''
  const candidates = [';', ',', '\t']
  const delimiter = candidates.sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0]
  const parsed: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false

  for (let index = 0; index < cleanText.length; index += 1) {
    const character = cleanText[index]
    if (character === '"') {
      if (quoted && cleanText[index + 1] === '"') {
        cell += '"'
        index += 1
      } else {
        quoted = !quoted
      }
    } else if (character === delimiter && !quoted) {
      row.push(cell.trim())
      cell = ''
    } else if (character === '\n' && !quoted) {
      row.push(cell.trim())
      if (row.some(Boolean)) parsed.push(row)
      row = []
      cell = ''
    } else {
      cell += character
    }
  }
  row.push(cell.trim())
  if (row.some(Boolean)) parsed.push(row)
  return { headers: parsed[0] ?? [], rows: parsed.slice(1) }
}

async function hashFile(file: File): Promise<string> {
  const data = await file.arrayBuffer()
  if (!globalThis.crypto?.subtle) return `${file.name}-${file.size}-${file.lastModified}`
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

export async function readBrowserFile(file: File): Promise<RawImportTable> {
  const extension = file.name.split('.').pop()?.toLocaleLowerCase('de-DE')
  if (extension === 'pdf') throw new Error('PDF-Dateien werden sicher in der nativen App verarbeitet. OCR-Scans werden nicht unterstützt.')

  let matrix: string[][]
  if (extension === 'xlsx' || extension === 'xlsm') {
    const { readSheet } = await import('read-excel-file/browser')
    const raw = await readSheet(file)
    matrix = raw.map((row) => row.map((cell) => (cell instanceof Date ? cell.toISOString().slice(0, 10) : String(cell ?? ''))))
  } else {
    const text = await file.text()
    const parsed = parseDelimitedText(text)
    return { fileName: file.name, fileHash: await hashFile(file), ...parsed }
  }
  return { fileName: file.name, fileHash: await hashFile(file), headers: matrix[0] ?? [], rows: matrix.slice(1) }
}

export function parseGermanAmount(value: string): number | null {
  const trimmed = value.trim().replace(/\s/g, '').replace(/[€$£]/g, '')
  if (!trimmed) return null
  const negative = trimmed.startsWith('-') || /^\(.+\)$/.test(trimmed)
  const unsigned = trimmed.replace(/[()−-]/g, '')
  let normalized: string
  if (unsigned.includes(',') && unsigned.includes('.')) {
    normalized = unsigned.lastIndexOf(',') > unsigned.lastIndexOf('.')
      ? unsigned.replace(/\./g, '').replace(',', '.')
      : unsigned.replace(/,/g, '')
  } else if (unsigned.includes(',')) {
    const separatorIndex = unsigned.lastIndexOf(',')
    const fractionLength = unsigned.length - separatorIndex - 1
    normalized = fractionLength === 3
      ? unsigned.replace(/,/g, '')
      : `${unsigned.slice(0, separatorIndex).replace(/,/g, '')}.${unsigned.slice(separatorIndex + 1)}`
  } else if (unsigned.includes('.')) {
    const separatorIndex = unsigned.lastIndexOf('.')
    const fractionLength = unsigned.length - separatorIndex - 1
    normalized = fractionLength === 3
      ? unsigned.replace(/\./g, '')
      : `${unsigned.slice(0, separatorIndex).replace(/\./g, '')}.${unsigned.slice(separatorIndex + 1)}`
  } else {
    normalized = unsigned
  }
  const number = Number(normalized)
  if (!Number.isFinite(number)) return null
  return Math.round(number * 100) * (negative ? -1 : 1)
}

export function parseImportDate(value: string): string | null {
  const trimmed = value.trim()
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`
  const german = /^(\d{1,2})[./](\d{1,2})[./](\d{2,4})/.exec(trimmed)
  if (!german) return null
  const year = german[3].length === 2 ? `20${german[3]}` : german[3]
  return `${year}-${german[2].padStart(2, '0')}-${german[1].padStart(2, '0')}`
}

const categoryFor = (text: string, amount: number): { category: Category; type: TransactionType } => {
  const value = text.toLocaleLowerCase('de-DE')
  if (amount > 0 && /erstattung|refund|retoure/.test(value)) return { category: 'Erstattung', type: 'refund' }
  if (amount > 0) return { category: 'Einkommen', type: 'income' }
  if (/trade republic|sparplan|wertpapier/.test(value)) return { category: 'Sparen & Investieren', type: 'investment' }
  if (/paypal.*lastschrift|ubertrag|übertrag/.test(value)) return { category: 'Transfer', type: 'transfer' }
  if (/supermarkt|stadtmarkt|rewe|edeka|aldi|lidl/.test(value)) return { category: 'Lebensmittel', type: 'expense' }
  if (/restaurant|cafe|café|lieferando|bohne/.test(value)) return { category: 'Gastronomie', type: 'expense' }
  if (/miete|hausverwaltung|energie/.test(value)) return { category: 'Wohnen', type: 'expense' }
  if (/bvg|bahn|verkehr|tankstelle/.test(value)) return { category: 'Mobilität', type: 'expense' }
  return { category: 'Unkategorisiert', type: 'expense' }
}

export function buildBrowserPreview(table: RawImportTable, source: TransactionSource, mapping = suggestMapping(table.headers)): ImportPreview {
  const index = (name?: string): number => name ? table.headers.indexOf(name) : -1
  const get = (row: string[], name?: string): string => row[index(name)] ?? ''
  const rows: PreviewRow[] = table.rows.map((raw, rowIndex) => {
    const date = parseImportDate(get(raw, mapping.date))
    const directAmount = parseGermanAmount(get(raw, mapping.amount))
    const debit = parseGermanAmount(get(raw, mapping.debit))
    const credit = parseGermanAmount(get(raw, mapping.credit))
    const amount = directAmount ?? (credit !== null ? Math.abs(credit) : debit !== null ? -Math.abs(debit) : null)
    const merchant = get(raw, mapping.merchant) || get(raw, mapping.description) || 'Unbekannte Gegenpartei'
    const description = get(raw, mapping.description) || merchant
    const classification = categoryFor(`${merchant} ${description}`, amount ?? -1)
    const currency = (get(raw, mapping.currency) || 'EUR').toLocaleUpperCase('de-DE')
    const mappedEurAmount = parseGermanAmount(get(raw, mapping.eurAmount))
    const eurAmount = currency === 'EUR'
      ? amount
      : mappedEurAmount !== null && amount !== null
        ? Math.abs(mappedEurAmount) * (amount < 0 ? -1 : 1)
        : mappedEurAmount
    const issues: string[] = []
    if (!date) issues.push('Datum konnte nicht gelesen werden')
    if (amount === null) issues.push('Betrag fehlt oder ist ungültig')
    if (currency !== 'EUR' && (eurAmount === null || (amount !== null && amount !== 0 && eurAmount === 0))) {
      issues.push(`EUR-Umrechnung für ${currency} fehlt`)
    }
    return {
      id: `browser-${rowIndex + 1}`,
      bookingDate: date,
      merchant,
      description,
      originalAmountMinor: amount,
      originalCurrency: currency,
      eurAmountMinor: issues.some((issue) => /EUR-Umrechnung/.test(issue)) ? null : eurAmount,
      type: classification.type,
      category: classification.category,
      included: issues.length === 0,
      duplicate: false,
      issues,
    }
  })
  return {
    previewId: `browser-preview-${Date.now()}`,
    fileName: table.fileName,
    fileHash: table.fileHash,
    source,
    rows,
    headers: table.headers,
    mapping,
    issues: rows.length ? [] : ['Die Datei enthält keine lesbaren Buchungszeilen.'],
    duplicateCount: 0,
  }
}
