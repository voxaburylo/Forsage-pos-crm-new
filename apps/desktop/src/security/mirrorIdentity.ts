import { generateKeyPairSync, sign } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** Private key never enters renderer/SQLite/export. Windows DPAPI protects it on disk. */
export function createMirrorSigner(root: string, crypto: { encrypt: (text: string) => string; decrypt: (text: string) => string }) {
  let privateKey: string | null = null
  return (text: string): string => {
    if (!privateKey) {
      const filename = path.join(root, 'mirror-identity.json')
      if (!existsSync(filename)) {
        const keys = generateKeyPairSync('ed25519')
        const pem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
        writeFileSync(filename, JSON.stringify({
          public_key: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
          encrypted_private_key: crypto.encrypt(pem),
        }), { flag: 'wx', mode: 0o600 })
      }
      privateKey = crypto.decrypt(JSON.parse(readFileSync(filename,'utf8')).encrypted_private_key)
    }
    return sign(null, Buffer.from(text), privateKey).toString('base64')
  }
}
