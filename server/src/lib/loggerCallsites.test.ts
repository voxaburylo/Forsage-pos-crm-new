import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { expect, it } from 'vitest'

it('application logger messages are literals, never documents or interpolated errors', () => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const failures: string[] = []
  let checked = 0
  const levels = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
  function inspect(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) { if (!['scripts', '__tests__'].includes(entry.name)) inspect(file); continue }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts') || entry.name === 'seed.ts') continue
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
      const names = new Set(['logger'])
      for (const statement of source.statements) {
        if (ts.isImportDeclaration(statement) && /\/logger\.js['"]$/.test(statement.moduleSpecifier.getText(source))) {
          const bindings = statement.importClause?.namedBindings
          if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) {
            if ((item.propertyName ?? item.name).text === 'logger') names.add(item.name.text)
          }
        }
      }
      function visit(node: ts.Node) {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
          && names.has(node.expression.expression.getText(source)) && levels.has(node.expression.name.text)) {
          checked++
          const args = node.arguments
          const message = args.length > 1 ? args[1] : args[0] && !ts.isObjectLiteralExpression(args[0]) ? args[0] : null
          if (args.length > 2 || message && !ts.isStringLiteral(message) && !ts.isNoSubstitutionTemplateLiteral(message)) {
            failures.push(path.relative(root, file) + ':' + (source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1))
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
  }
  inspect(root)
  expect(checked).toBeGreaterThan(150)
  expect(failures).toEqual([])
})
