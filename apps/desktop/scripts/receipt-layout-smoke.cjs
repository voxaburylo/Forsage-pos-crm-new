// Read synthetic HTML cases only; never imports main/database/physical printing.
const {app,nativeImage}=require('electron')
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict')
const dist=path.resolve(__dirname,process.argv.includes('--packaged')?'../release/win-unpacked/resources/app.asar/dist':'../dist')
const {renderReceiptRaster}=require(path.join(dist,'print/receiptRaster.js'))
const work=fs.mkdtempSync(path.join(os.tmpdir(),'forsage-receipt-native-'))
app.setPath('userData',path.join(work,'profile'))
if(process.argv.includes('--software'))app.disableHardwareAcceleration()
if(process.env.FORSAGE_TEST_DPR)app.commandLine.appendSwitch('force-device-scale-factor',process.env.FORSAGE_TEST_DPR)
app.on('window-all-closed',()=>{})
const timer=setTimeout(()=>{console.error('Native receipt deadline');app.exit(1)},80_000)
app.whenReady().then(async()=>{
 const cases=JSON.parse(fs.readFileSync(process.argv[2],'utf8'))
 let previousHeight=0
 for(const item of cases){
  const png=await renderReceiptRaster(item.html,{widthDots:384,dpiX:203,dpiY:203})
  const image=nativeImage.createFromBuffer(png),{width,height}=image.getSize(),pixels=image.toBitmap({scaleFactor:1})
  assert.equal(width,384);assert(height>previousHeight);previousHeight=height
  let lastBand=-1
  for(let y=0;y<height;y++){
   let black=0
   for(let x=0;x<width;x++){const value=pixels[(y*width+x)*4];assert(value===0||value===255);if(value===0)black++}
   if(black>350)lastBand=y
  }
  // The footer is followed by the production 6 mm bottom padding (~48 dots).
  for(let y=height-30;y<height;y++)for(let x=0;x<width;x++)assert.equal(pixels[(y*width+x)*4],255,'Paint fence leaked onto the receipt')
  assert(lastBand>height-60&&lastBand<height-40,'Missing last footer: '+JSON.stringify({height,lastBand}))
  console.log('Full receipt raster',JSON.stringify({items:item.count,width,height,lastBand}))
 }
 clearTimeout(timer);app.quit()
}).catch(error=>{console.error(error);app.exit(1)})
app.on('quit',()=>{if(path.dirname(work)===path.resolve(os.tmpdir())&&path.basename(work).startsWith('forsage-receipt-native-')){try{fs.rmSync(work,{recursive:true,force:true})}catch{}}})
