// Finds English text in editor components that bypasses core/i18n: JSX text, text-bearing attributes (title,
// aria-label, placeholder, ...), and string literals rendered from a JSX expression or passed to
// alert/confirm/prompt. The coverage test (src/editor/i18nCoverage.test.ts) runs it over every component.
//
// It reads value positions only: a literal that is the rendered value (`{on ? 'Hide' : 'Show'}`), not one that
// is compared, indexed or handed to a function, so class names and ids pass. A line carrying `i18n-ok` (or the
// line above it) is skipped: IEC keywords, units, tag names and other text that must not change.
import { readFileSync } from 'node:fs'
import ts from 'typescript'

/** Attributes whose value a person reads. */
const TEXT_ATTRS = new Set([
  'title',
  'aria-label',
  'aria-description',
  'aria-roledescription',
  'aria-placeholder',
  'aria-valuetext',
  'placeholder',
  'alt',
  'label',
])

/** Calls whose string arguments are shown to the person. */
const TEXT_CALLS = new Set(['alert', 'confirm', 'prompt'])

/** Two letters in a row: a word, as against '×', '·', '…', a number or a lone axis letter. */
const WORDY = /[A-Za-z]{2,}/

/** @returns {{ line: number, text: string }[]} */
export function scanSource(fileName, source) {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const lines = source.split('\n')
  const found = []
  const exempt = (node) => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line
    return lines[line]?.includes('i18n-ok') || (line > 0 && lines[line - 1]?.includes('i18n-ok'))
  }
  const report = (node, text) => {
    if (!WORDY.test(text) || exempt(node)) return
    found.push({ line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text: text.trim().slice(0, 80) })
  }

  /** The literals an expression evaluates to, followed through the operators that pass a value along. */
  const values = (e) => {
    if (!e) return
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return report(e, e.text)
    if (ts.isTemplateExpression(e)) {
      report(e.head, e.head.text)
      for (const span of e.templateSpans) {
        report(span.literal, span.literal.text)
        values(span.expression)
      }
      return
    }
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) return values(e.expression)
    if (ts.isConditionalExpression(e)) return (values(e.whenTrue), values(e.whenFalse))
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind
      if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) return (values(e.left), values(e.right))
      if (op === ts.SyntaxKind.AmpersandAmpersandToken) return values(e.right)
      if (op === ts.SyntaxKind.PlusToken) return (values(e.left), values(e.right))
      return
    }
    if (ts.isArrayLiteralExpression(e)) for (const el of e.elements) values(el)
  }

  const visit = (node) => {
    if (ts.isJsxText(node)) report(node, node.text)
    else if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(sf)
      if (TEXT_ATTRS.has(name)) {
        const init = node.initializer
        if (init && ts.isStringLiteral(init)) report(init, init.text)
        else if (init && ts.isJsxExpression(init)) values(init.expression)
      }
    } else if (ts.isJsxExpression(node) && node.parent && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
      values(node.expression)
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : ''
      if (TEXT_CALLS.has(name)) for (const arg of node.arguments) values(arg)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

export function scanFile(path) {
  return scanSource(path, readFileSync(path, 'utf8'))
}
