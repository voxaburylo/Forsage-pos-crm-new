/**
 * Розпізнавач штрихкодів для телефонів без вбудованого (iPhone): zxing у WebAssembly — у рази швидший за стару
 * бібліотеку. Файл .wasm іде з нашого ж сайту (браузер тримає його в кеші), а не з чужого CDN.
 */
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url'

type Detector = { detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>> }

// Один і той самий об'єкт: модуль порівнює налаштування й не завантажує .wasm вдруге при кожному ввімкненні камери.
const overrides = { locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? wasmUrl : prefix + path) }

export async function createZxingDetector(formats: readonly string[]): Promise<Detector> {
  const { BarcodeDetector, prepareZXingModule } = await import('barcode-detector/ponyfill')
  // Чекаємо на .wasm одразу: якщо він не завантажився — сканер перейде на стару бібліотеку, а не мовчатиме.
  await prepareZXingModule({ overrides, fireImmediately: true })
  return new BarcodeDetector({ formats: [...formats] as never })
}
