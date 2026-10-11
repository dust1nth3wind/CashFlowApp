import { expect, test, type Page } from '@playwright/test'
import path from 'node:path'

const demoBankCsv = path.join(process.cwd(), 'e2e/fixtures/bank-demo.csv')

async function openDemo(page: Page) {
  await page.goto('/?demo=1')
  await expect(page.getByTestId('app-shell')).toBeVisible()
}

async function openSection(
  page: Page,
  testId: 'nav-dashboard' | 'nav-transactions' | 'nav-import' | 'nav-settings',
  heading: RegExp,
) {
  await page.getByTestId(testId).first().click()
  await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible()
}

test.describe('Übersicht und Navigation', () => {
  test('zeigt die wichtigsten Finanzkennzahlen und Auswertungen', async ({ page }) => {
    await openDemo(page)

    await expect(page.getByRole('heading', { name: /^Übersicht$/, level: 1 })).toBeVisible()
    await expect(page.getByText(/^Einnahmen$/).first()).toBeVisible()
    await expect(page.getByText(/^Ausgaben$/).first()).toBeVisible()
    await expect(page.getByText(/Netto-Cashflow/i).first()).toBeVisible()
    await expect(page.getByText(/Investiert/i).first()).toBeVisible()
    await expect(page.getByRole('heading', { name: /Monatsverlauf/i })).toBeVisible()
    await expect(page.getByRole('heading', { name: /Kategorien/i })).toBeVisible()
    await expect(page.getByRole('heading', { name: /Letzte Buchungen/i })).toBeVisible()
  })

  test('wechselt ohne Seitenneuladen zwischen allen Hauptbereichen', async ({ page }) => {
    await openDemo(page)

    await openSection(page, 'nav-transactions', /^Transaktionen$/)
    await openSection(page, 'nav-import', /^Import$/)
    await openSection(page, 'nav-settings', /Regeln & Einstellungen/i)
    await openSection(page, 'nav-dashboard', /^Übersicht$/)
  })

  test('zeigt beim leeren Erststart einen klaren Importweg', async ({ page }) => {
    await page.goto('/?fresh=1')

    await expect(page.getByTestId('app-shell')).toBeVisible()
    await expect(page.getByRole('heading', { name: /^Übersicht$/, level: 1 })).toBeVisible()
    await expect(page.getByText(/noch keine|keine Transaktionen|ersten Import/i).first()).toBeVisible()
    await expect(page.getByRole('button', { name: /import/i }).first()).toBeVisible()
  })
})

test.describe('Transaktionen', () => {
  test.beforeEach(async ({ page }) => {
    await openDemo(page)
    await openSection(page, 'nav-transactions', /^Transaktionen$/)
  })

  test('filtert die Liste über die Suche', async ({ page }) => {
    const search = page.getByRole('searchbox', { name: /Transaktionen|suchen/i })
    await expect(search).toBeVisible()

    const rows = page.getByRole('row')
    const initialCount = await rows.count()
    await search.fill('Stadtmarkt')

    await expect(page.getByText(/Stadtmarkt/i).first()).toBeVisible()
    expect(await rows.count()).toBeLessThan(initialCount)
  })

  test('ändert eine Kategorie und behält die Korrektur beim Bereichswechsel', async ({ page }) => {
    const categorySelect = page.locator('[data-testid^="category-"]').first()
    await expect(categorySelect).toBeVisible()

    await categorySelect.selectOption({ label: 'Lebensmittel' })
    await expect(categorySelect).toHaveValue(/Lebensmittel/i)

    await openSection(page, 'nav-dashboard', /^Übersicht$/)
    await openSection(page, 'nav-transactions', /^Transaktionen$/)
    await expect(page.locator('[data-testid^="category-"]').first()).toHaveValue(/Lebensmittel/i)
  })

  test('schließt einen manuell markierten Transfer aus und nimmt ihn beim Rückwechsel wieder auf', async ({ page }) => {
    const categorySelect = page.locator('[data-testid^="category-"]').first()
    const row = categorySelect.locator('xpath=ancestor::tr')

    await categorySelect.selectOption({ label: 'Transfer' })
    await expect(row.locator('td').last()).toHaveClass(/muted/)

    await categorySelect.selectOption({ label: 'Sonstiges' })
    await expect(row.locator('td').last()).not.toHaveClass(/muted/)
  })

  test('stellt offene Zuordnungen in einer eigenen Prüfansicht dar', async ({ page }) => {
    const reviewTab = page.getByRole('button', { name: /Offene Prüfung/i })
    await expect(reviewTab).toBeVisible()
    await reviewTab.click()

    await expect(reviewTab).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByText(/Prüfung|Doppel|Zuordnung/i).first()).toBeVisible()
  })

  test('löst eine offene Zuordnung bewusst als getrennte Buchungen', async ({ page }) => {
    await page.getByRole('button', { name: /Offene Prüfung/i }).click()
    const action = page.getByRole('button', { name: /Getrennt lassen/i })
    await expect(action).toBeVisible()
    await action.click()

    await expect(action).not.toBeVisible()
  })

  test('ergänzt eine fehlende EUR-Umrechnung in der Prüfansicht', async ({ page }) => {
    await page.getByRole('button', { name: /Offene Prüfung/i }).click()
    const input = page.getByRole('textbox', { name: /EUR-Betrag für Adobe Creative Cloud/i })
    await expect(input).toBeVisible()
    await input.fill('13,75')
    await page.getByRole('button', { name: 'Übernehmen' }).click()

    await expect(input).not.toBeVisible()
    await page.getByRole('button', { name: /Alle Buchungen/i }).click()
    const adobeRow = page.getByRole('row').filter({ hasText: 'Adobe Creative Cloud' })
    await expect(adobeRow).toContainText(/13,75/)
  })
})

test.describe('Import', () => {
  test('liest eine lokale CSV zunächst nur in die Vorschau ein', async ({ page }) => {
    await page.goto('/?fresh=1')
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await openSection(page, 'nav-import', /^Import$/)

    const fileInput = page.getByTestId('import-file-input')
    await fileInput.setInputFiles(demoBankCsv)

    await expect(page.getByText('bank-demo.csv')).toBeVisible()
    await expect(page.getByRole('heading', { name: /Vorschau/i })).toBeVisible()
    await expect(page.getByText(/Stadtmarkt Mitte/i).first()).toBeVisible()
    await page.getByText('Spaltenzuordnung', { exact: true }).click()
    await expect(page.getByRole('combobox', { name: 'Betrag', exact: true })).toHaveValue('Betrag')
    await expect(page.getByRole('button', { name: /importieren|übernehmen|bestätigen/i })).toBeEnabled()
  })

  test('überspringt beim Wiederholungsimport alle bereits bekannten Buchungen', async ({ page }) => {
    await page.goto('/?fresh=1')
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await openSection(page, 'nav-import', /^Import$/)

    await page.getByTestId('import-file-input').setInputFiles(demoBankCsv)
    await page.getByRole('button', { name: /Auswahl importieren/i }).click()
    await expect(page.getByRole('heading', { name: /6 Buchungen wurden übernommen/i })).toBeVisible()
    await expect(page.getByText(/keine Doppelungen gefunden/i)).toBeVisible()

    await page.getByRole('button', { name: /Weitere Datei importieren/i }).click()
    await page.getByTestId('import-file-input').setInputFiles(demoBankCsv)
    await page.getByRole('button', { name: /Auswahl importieren/i }).click()

    await expect(page.getByRole('heading', { name: /0 Buchungen wurden übernommen/i })).toBeVisible()
    await expect(page.getByText(/6 bereits bekannte Zeilen.*übersprungen/i)).toBeVisible()
  })

  test('beschränkt die Dateiauswahl auf unterstützte lokale Formate', async ({ page }) => {
    await page.goto('/?fresh=1')
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await openSection(page, 'nav-import', /^Import$/)

    await expect(page.getByTestId('import-file-input')).toHaveAttribute(
      'accept',
      /\.csv.*\.xlsx.*\.xlsm.*\.pdf/i,
    )
  })
})

test.describe('Regeln', () => {
  test('wendet eine Regel auf bestehende Importe an und schützt manuelle Korrekturen', async ({ page }) => {
    await openDemo(page)
    await openSection(page, 'nav-transactions', /^Transaktionen$/)
    await page.getByRole('searchbox', { name: /Transaktionen|suchen/i }).fill('Stadtmarkt')
    await page.getByLabel('Korrektur als Regel merken').uncheck()
    await page.locator('[data-testid^="category-"]').first().selectOption({ label: 'Gastronomie' })

    await openSection(page, 'nav-settings', /Regeln & Einstellungen/i)
    const ruleRow = page.locator('.rule-row:has(input[value="Stadtmarkt"])')
    await ruleRow.locator('select').nth(1).selectOption({ label: 'Shopping' })
    page.once('dialog', (dialog) => dialog.accept())
    await ruleRow.getByRole('button', { name: 'Regel auf bestehende Buchungen anwenden' }).click()
    await expect(page.getByText(/manuell korrigierte Buchung blieb unverändert/i)).toBeVisible()

    await openSection(page, 'nav-transactions', /^Transaktionen$/)
    await page.getByRole('searchbox', { name: /Transaktionen|suchen/i }).fill('Stadtmarkt')
    const categories = await page.locator('[data-testid^="category-"]').evaluateAll(
      (selects) => selects.map((select) => (select as HTMLSelectElement).value),
    )
    expect(categories).toContain('Gastronomie')
    expect(categories).toContain('Shopping')
  })
})

test.describe('Grundlegende Zugänglichkeit und kleine Fenster', () => {
  test('stellt Navigation und Hauptinhalt als benannte Bereiche bereit', async ({ page }) => {
    await openDemo(page)

    await expect(page.getByRole('navigation', { name: /Hauptnavigation/i }).first()).toBeVisible()
    await expect(page.getByRole('main')).toBeVisible()

    await page.keyboard.press('Tab')
    const focusedElement = page.locator(':focus')
    await expect(focusedElement).toBeVisible()
    await expect(focusedElement).not.toHaveJSProperty('tagName', 'BODY')
  })

  test('nutzt bei schmalen Fenstern die kompakte Navigation ohne horizontalen Überlauf', async ({ page }) => {
    await page.setViewportSize({ width: 700, height: 760 })
    await openDemo(page)

    await expect(page.getByTestId('mobile-nav')).toBeVisible()
    await expect(page.getByTestId('nav-dashboard').last()).toBeVisible()
    await expect(page.getByTestId('nav-import').last()).toBeVisible()

    const hasHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    )
    expect(hasHorizontalOverflow).toBe(false)
  })
})

test.describe('Lokale Wiederherstellung', () => {
  test('zeigt eine geladene Sicherung an und bestätigt die Wiederherstellung', async ({ page }) => {
    await openDemo(page)
    await page.evaluate(() => {
      const key = 'cashflow-demo-state-v1'
      const state = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, unknown>
      state.recovery = { loadedFromBackup: true, message: 'Die Hauptdatei war beschädigt.' }
      localStorage.setItem(key, JSON.stringify(state))
    })
    await page.goto('/')

    await expect(page.getByText(/Sicherung geladen/i)).toBeVisible()
    page.once('dialog', (dialog) => dialog.accept())
    await page.getByRole('button', { name: /Wiederherstellen/i }).click()
    await expect(page.getByText(/Sicherung geladen/i)).not.toBeVisible()
  })
})
