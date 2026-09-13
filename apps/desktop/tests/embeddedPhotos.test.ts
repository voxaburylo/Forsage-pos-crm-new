import { expect,it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { DatabaseSync } from 'node:sqlite'
import { copyFileSync,mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL,fileURLToPath } from 'node:url'
import { embedBackupPhotos,restoreEmbeddedPhotos } from '../src/backup/embeddedPhotos'
it('restores embedded photos on another root and keeps original files untouched',async()=>{
 const root=mkdtempSync(path.join(tmpdir(),'forsage-assets-test-'))
 const photo=path.join(root,'photos','a.jpg');mkdirSync(path.dirname(photo));writeFileSync(photo,'test-image')
 const snapshot=path.join(root,'copy.db');let db=new DatabaseSync(snapshot);db.exec('CREATE TABLE products(photo_url TEXT)');db.prepare('INSERT INTO products VALUES (?)').run(pathToFileURL(photo).href);db.close()
 try {await embedBackupPhotos(snapshot,root);db=new DatabaseSync(snapshot);restoreEmbeddedPhotos(db,path.join(root,'other'));const row=db.prepare('SELECT photo_url FROM products').get() as any;expect(readFileSync(fileURLToPath(row.photo_url),'utf8')).toBe('test-image');expect(readFileSync(photo,'utf8')).toBe('test-image');restoreEmbeddedPhotos(db,path.join(root,'other'));db.close()}
 finally {if(path.dirname(root)===path.resolve(tmpdir())&&path.basename(root).startsWith('forsage-assets-test-'))rmSync(root,{recursive:true,force:true})}
})

it('opens the full backup as a working database in an isolated root with quantities and photos',async()=>{
 const root=mkdtempSync(path.join(tmpdir(),'forsage-assets-test-'));let original:LocalDatabase|undefined,restored:LocalDatabase|undefined
 try {
  original=new LocalDatabase(root)
  const photo=path.join(root,'photos','original.png');mkdirSync(path.dirname(photo),{recursive:true});writeFileSync(photo,'picture')
  new LocalCatalogRepository(original).saveProduct({id:'restore-product',sku:'0001',name:'Відновлення',qty_on_hand:8,photo_url:pathToFileURL(photo).href})
  const snapshot=await original.backupNow();await embedBackupPhotos(snapshot,root)
  const target=path.join(root,'restored');mkdirSync(path.join(target,'data'),{recursive:true});copyFileSync(snapshot,path.join(target,'data','forsage.db'))
  restored=new LocalDatabase(target)
  const product=new LocalCatalogRepository(restored).findById('restore-product')! as unknown as { qty_on_hand: number; photo_url: string }
  expect(product.qty_on_hand).toBe(8);expect(readFileSync(fileURLToPath(product.photo_url!),'utf8')).toBe('picture')
  expect(fileURLToPath(product.photo_url!).startsWith(path.join(target,'photos'))).toBe(true)
  expect(original.prepare('PRAGMA quick_check').get()).toEqual({quick_check:'ok'})
 }finally{restored?.close();original?.close();if(path.dirname(root)===path.resolve(tmpdir())&&path.basename(root).startsWith('forsage-assets-test-'))rmSync(root,{recursive:true,force:true})}
})
