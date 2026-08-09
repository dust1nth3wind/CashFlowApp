import { describe, expect, it } from 'vitest'
import { buildBrowserPreview, parseDelimitedText, parseGermanAmount, parseImportDate, suggestMapping } from './browserImport'

describe('Browser-Import', () => {
  it('liest deutsche Geldformate ohne Fließkomma-Rundungsfehler', () => {
    expect(parseGermanAmount('-1.234,56 €')).toBe(-123_456)
    expect(parseGermanAmount('3,99')).toBe(399)
    expect(parseGermanAmount('(12,50)')).toBe(-1_250)
    expect(parseGermanAmount('')).toBeNull()
  })

  it('liest deutsche und ISO-Daten', () => {
    expect(parseImportDate('09.08.2026')).toBe('2026-08-09')
    expect(parseImportDate('2026-08-09T10:00:00')).toBe('2026-08-09')
    expect(parseImportDate('unbekannt')).toBeNull()
  })

  it('behandelt Trennzeichen, Zeilenumbrüche und Anführungszeichen', () => {
    const parsed = parseDelimitedText('Datum;Text;Betrag\n01.08.2026;"Café; Mitte";-12,40\n')
    expect(parsed.headers).toEqual(['Datum', 'Text', 'Betrag'])
    expect(parsed.rows[0]).toEqual(['01.08.2026', 'Café; Mitte', '-12,40'])
  })

  it('verwechselt Wertstellung nicht mit Betrag', () => {
    const mapping = suggestMapping(['Buchungstag', 'Wertstellung', 'Empfänger', 'Betrag', 'Währung', 'Betrag in EUR'])
    expect(mapping.amount).toBe('Betrag')
    expect(mapping.date).toBe('Buchungstag')
    expect(mapping.eurAmount).toBe('Betrag in EUR')
  })

  it('erstellt vor dem Speichern eine prüfbare Vorschau', () => {
    const preview = buildBrowserPreview({
      fileName: 'bank.csv',
      fileHash: 'hash',
      headers: ['Buchungstag', 'Empfänger', 'Verwendungszweck', 'Betrag', 'Währung'],
      rows: [['03.08.2026', 'Stadtmarkt Mitte', 'Wocheneinkauf', '-86,42', 'EUR']],
    }, 'bank')
    expect(preview.rows[0]).toMatchObject({ merchant: 'Stadtmarkt Mitte', category: 'Lebensmittel', originalAmountMinor: -8642, included: true })
  })

  it('übernimmt einen vorhandenen EUR-Wert mit dem Vorzeichen des Originalbetrags', () => {
    const preview = buildBrowserPreview({
      fileName: 'paypal.csv',
      fileHash: 'hash',
      headers: ['Datum', 'Beschreibung', 'Betrag', 'Währung', 'Betrag in EUR'],
      rows: [['03.08.2026', 'Einkauf', '-15,00', 'USD', '12,75']],
    }, 'paypal')

    expect(preview.rows[0]).toMatchObject({
      originalAmountMinor: -1500,
      originalCurrency: 'USD',
      eurAmountMinor: -1275,
      included: true,
      issues: [],
    })
  })

  it('lässt eine Null-Umrechnung für einen echten Fremdwährungsbetrag offen', () => {
    const preview = buildBrowserPreview({
      fileName: 'paypal.csv',
      fileHash: 'hash',
      headers: ['Datum', 'Beschreibung', 'Betrag', 'Währung', 'Betrag in EUR'],
      rows: [['03.08.2026', 'Einkauf', '-15,00', 'USD', '0,00']],
    }, 'paypal')

    expect(preview.rows[0]).toMatchObject({ eurAmountMinor: null, included: false })
    expect(preview.rows[0].issues).toContain('EUR-Umrechnung für USD fehlt')
  })
})
