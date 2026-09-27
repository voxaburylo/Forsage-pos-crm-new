import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {readAiSupplyInput} from './readAiSupplyInput'
describe('local AI input worker lifecycle',()=>{
 let worker:any
 beforeEach(()=>{
  vi.useFakeTimers()
  worker={onmessage:null,onerror:null,onmessageerror:null,postMessage:vi.fn(),terminate:vi.fn()}
  vi.stubGlobal('Worker',class{constructor(){return worker}})
 })
 afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals()})
 it('returns a result once and disposes all worker resources',async()=>{
  const result={text:'source',products:[],categoryCount:0}
  const pending=readAiSupplyInput({text:'source'});const late=worker.onmessage
  worker.onmessage({data:{result}})
  expect(await pending).toEqual(result)
  late({data:{result}})
  expect(worker.terminate).toHaveBeenCalledTimes(1)
  expect(worker.onmessage).toBeNull();expect(worker.onmessageerror).toBeNull();expect(vi.getTimerCount()).toBe(0)
 })
 it.each([null,undefined,[],{}, {result:{}}, {error:{private:'data'}}])('rejects malformed reply %j immediately',async data=>{
  const pending=readAiSupplyInput({text:'source'})
  const check=expect(pending).rejects.toThrow()
  worker.onmessage({data});await check
  expect(worker.terminate).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0)
 })
 it.each(['onerror','onmessageerror'])('disposes on %s',async key=>{
  const pending=readAiSupplyInput({text:'source'});const check=expect(pending).rejects.toThrow()
  worker[key]({});await check
  expect(worker.terminate).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0)
 })
 it('handles transfer failure without exposing a raw platform error',async()=>{
  worker.postMessage.mockImplementation(()=>{throw Error('private raw platform data')})
  await expect(readAiSupplyInput({text:'source'})).rejects.toThrow('передати файл')
  expect(worker.terminate).toHaveBeenCalledOnce()
 })
 it('terminates a stalled worker after 30 seconds',async()=>{
  const pending=readAiSupplyInput({text:'source'});const check=expect(pending).rejects.toThrow('надто довго')
  await vi.advanceTimersByTimeAsync(30_000);await check
  expect(worker.terminate).toHaveBeenCalledOnce()
 })
 it('provides a clear error when the worker cannot start',async()=>{
  vi.stubGlobal('Worker',class{constructor(){throw Error('file:///private/path')}})
  await expect(readAiSupplyInput({text:'source'})).rejects.toThrow('запустити')
  expect(vi.getTimerCount()).toBe(0)
 })
})
