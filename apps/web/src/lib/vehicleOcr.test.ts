import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks=vi.hoisted(()=>({post:vi.fn(),upload:vi.fn(),remove:vi.fn(),toBlob:vi.fn()}))
vi.mock('./api',()=>({api:{post:mocks.post}}))
vi.mock('./processingUploads',()=>({uploadProcessingBlob:mocks.upload,removeProcessingUploads:mocks.remove,dataUrlToBlob:mocks.toBlob}))
import { recognizeVehicleImage } from './vehicleOcr'

describe('VIN shares safe image preparation with invoice photos',()=>{
 let image:any,canvas:any,context:any,revoke:ReturnType<typeof vi.fn>
 const file=new Blob(['fixture'],{type:'image/png'})
 beforeEach(()=>{
  vi.useFakeTimers();vi.resetAllMocks()
  image={naturalWidth:3200,naturalHeight:1600,onload:null,onerror:null,src:''}
  context={fillStyle:'',fillRect:vi.fn(),drawImage:vi.fn()}
  canvas={width:0,height:0,getContext:()=>context,toDataURL:vi.fn(()=>'data:image/jpeg;base64,Zml4dHVyZQ==')}
  revoke=vi.fn()
  vi.stubGlobal('Image',class{constructor(){return image}})
  vi.stubGlobal('URL',{createObjectURL:vi.fn(()=>'blob:fixture'),revokeObjectURL:revoke})
  vi.stubGlobal('document',{createElement:()=>canvas})
  mocks.toBlob.mockReturnValue(new Blob(['jpeg'],{type:'image/jpeg'}))
  mocks.upload.mockResolvedValue({path:'fixture/vin/unique.jpg'})
  mocks.remove.mockResolvedValue(undefined)
  mocks.post.mockResolvedValue({data:{vin:'TESTVIN',make:'Test',model:null,year:null}})
 })
 afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals()})
 it('paints white before JPEG, retains VIN dimensions, and removes temporary upload',async()=>{
  const pending=recognizeVehicleImage(file);image.onload()
  expect((await pending).vin).toBe('TESTVIN')
  expect([canvas.width,canvas.height]).toEqual([1600,800])
  expect(context.fillStyle).toBe('#ffffff')
  expect(context.fillRect.mock.invocationCallOrder[0]).toBeLessThan(context.drawImage.mock.invocationCallOrder[0])
  expect(canvas.toDataURL).toHaveBeenCalledWith('image/jpeg',0.82)
  expect(mocks.upload.mock.calls[0][1]).toBe('vin')
  expect(mocks.remove).toHaveBeenCalledWith(['fixture/vin/unique.jpg'])
  expect(revoke).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0)
 })
 it('finishes failed decoding after 15 seconds, before any upload',async()=>{
  const result=expect(recognizeVehicleImage(file)).rejects.toThrow('15 секунд')
  await vi.advanceTimersByTimeAsync(15_000);await result
  expect(mocks.upload).not.toHaveBeenCalled();expect(mocks.post).not.toHaveBeenCalled()
  expect(image.onload).toBeNull();expect(revoke).toHaveBeenCalledOnce()
 })
 it('rejects invalid files before decoding',async()=>{
  await expect(recognizeVehicleImage(new Blob(['x'],{type:'text/plain'}))).rejects.toThrow('фото')
  await expect(recognizeVehicleImage(new Blob([],{type:'image/png'}))).rejects.toThrow('порожнє')
  await expect(recognizeVehicleImage(new Blob([new Uint8Array(20*1024*1024+1)],{type:'image/png'}))).rejects.toThrow('20 МБ')
  expect(URL.createObjectURL).not.toHaveBeenCalled();expect(mocks.upload).not.toHaveBeenCalled()
 })
 it('cleans temporary files after a server failure and propagates the original failure',async()=>{
  mocks.post.mockRejectedValue(Error('server fixture'))
  const pending=recognizeVehicleImage(file);image.onload()
  await expect(pending).rejects.toThrow('server fixture')
  expect(mocks.remove).toHaveBeenCalledOnce()
 })
})
