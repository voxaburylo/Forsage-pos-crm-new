// Шаблони характеристик для категорій автомагазину
// Значення зберігаються в products.specs (JSONB)

export type SpecFieldType = 'number' | 'text' | 'select'

export interface SpecField {
  key: string
  label: string
  type: SpecFieldType
  unit?: string
  placeholder?: string
  options?: string[]
  required?: boolean
}

export interface SpecTemplate {
  label: string         // заголовок секції
  fields: SpecField[]
}

// Ключі — частини назви категорії (toLowerCase includes)
const TEMPLATES: Array<{ match: string[]; template: SpecTemplate }> = [
  {
    match: ['шин'],
    template: {
      label: '🚗 Характеристики шини',
      fields: [
        { key: 'width',       label: 'Ширина',            type: 'number', unit: 'мм',    placeholder: '205', required: true },
        { key: 'profile',     label: 'Профіль',           type: 'number', unit: '%',     placeholder: '55',  required: true },
        { key: 'rim',         label: 'Діаметр диска',     type: 'number', unit: '"',     placeholder: '16',  required: true },
        { key: 'season',      label: 'Сезон',             type: 'select', options: ['Літня', 'Зимова', 'Всесезонна'] },
        { key: 'load_index',  label: 'Індекс навант.',    type: 'text',   placeholder: '91T' },
        { key: 'speed_index', label: 'Індекс швидкості',  type: 'select', options: ['N','P','Q','R','S','T','U','H','V','W','Y','ZR'] },
        { key: 'runflat',     label: 'RunFlat',           type: 'select', options: ['Ні', 'Так'] },
      ],
    },
  },
  {
    match: ['акумулятор'],
    template: {
      label: '🔋 Характеристики акумулятора',
      fields: [
        { key: 'capacity',    label: 'Ємність',           type: 'number', unit: 'Ач',  placeholder: '60',  required: true },
        { key: 'cca',         label: 'Пусковий струм',    type: 'number', unit: 'А',   placeholder: '540' },
        { key: 'voltage',     label: 'Напруга',           type: 'select', options: ['12', '24'],             required: true },
        { key: 'polarity',    label: 'Полярність',        type: 'select', options: ['Пряма (+ зліва)', 'Зворотна (+ справа)'] },
        { key: 'length',      label: 'Довжина',           type: 'number', unit: 'мм',  placeholder: '242' },
        { key: 'width',       label: 'Ширина',            type: 'number', unit: 'мм',  placeholder: '175' },
        { key: 'height',      label: 'Висота',            type: 'number', unit: 'мм',  placeholder: '190' },
        { key: 'technology',  label: 'Технологія',        type: 'select', options: ['AGM', 'EFB', 'WET', 'GEL', 'Ca/Ca'] },
      ],
    },
  },
  {
    match: ['лампоч', 'освітлен', 'лампи', 'lamp'],
    template: {
      label: '💡 Характеристики лампи',
      fields: [
        { key: 'bulb_type',   label: 'Тип цоколя',        type: 'select', options: ['H1','H3','H4','H7','H8','H11','H15','HB3','HB4','9005','9006','W5W','T10','P21W','P21/5W','R5W','BAY15d','W21W','LED-H4','LED-H7','LED-H11'], required: true },
        { key: 'voltage',     label: 'Напруга',            type: 'select', options: ['12V', '24V'] },
        { key: 'wattage',     label: 'Потужність',         type: 'number', unit: 'Вт',  placeholder: '55' },
        { key: 'lumen',       label: 'Світловий потік',   type: 'number', unit: 'лм',  placeholder: '1500' },
        { key: 'color_temp',  label: 'Кольорова темп.',   type: 'number', unit: 'K',   placeholder: '4300' },
        { key: 'light_color', label: 'Колір світла',      type: 'select', options: ['Білий', 'Жовтий', 'Блакитний', 'RGB'] },
        { key: 'quantity',    label: 'К-сть в упаковці',  type: 'number', placeholder: '1' },
      ],
    },
  },
  {
    match: ['масл', 'олив', 'мотор'],
    template: {
      label: '🛢 Характеристики оливи',
      fields: [
        { key: 'viscosity',   label: 'В\'язкість SAE',    type: 'select', options: ['0W-20','0W-30','0W-40','5W-30','5W-40','5W-50','10W-30','10W-40','10W-60','15W-40','20W-50'], required: true },
        { key: 'api',         label: 'Стандарт API',      type: 'select', options: ['SN','SN+','SP','CF','CK-4','CI-4'] },
        { key: 'acea',        label: 'Стандарт ACEA',     type: 'select', options: ['A1/B1','A3/B3','A3/B4','A5/B5','C1','C2','C3','C4','C5','E6','E7','E9'] },
        { key: 'volume',      label: 'Об\'єм',            type: 'select', options: ['0.5 л','1 л','2 л','4 л','5 л','10 л','20 л','60 л','208 л'], required: true },
        { key: 'synthetic',   label: 'Тип основи',        type: 'select', options: ['Синтетика', 'Напівсинтетика', 'Мінералка'] },
        { key: 'approved',    label: 'Допуски VW/BMW/MB', type: 'text',   placeholder: 'VW 504.00, MB 229.5' },
      ],
    },
  },
  {
    match: ['фільтр масл'],
    template: {
      label: '🔧 Характеристики масляного фільтра',
      fields: [
        { key: 'height',      label: 'Висота',            type: 'number', unit: 'мм',  placeholder: '90' },
        { key: 'outer_d',     label: 'Зовн. діаметр',     type: 'number', unit: 'мм',  placeholder: '76' },
        { key: 'thread',      label: 'Різьба',            type: 'text',   placeholder: 'M20x1.5' },
        { key: 'bypass_psi',  label: 'Тиск байпасу',      type: 'number', unit: 'psi', placeholder: '11' },
      ],
    },
  },
  {
    match: ['фільтр повітр'],
    template: {
      label: '💨 Характеристики повітряного фільтра',
      fields: [
        { key: 'length',      label: 'Довжина',           type: 'number', unit: 'мм',  placeholder: '280' },
        { key: 'width',       label: 'Ширина',            type: 'number', unit: 'мм',  placeholder: '195' },
        { key: 'height',      label: 'Висота',            type: 'number', unit: 'мм',  placeholder: '40' },
        { key: 'shape',       label: 'Форма',             type: 'select', options: ['Прямокутний', 'Круглий', 'Конічний', 'Панельний'] },
      ],
    },
  },
  {
    match: ['фільтр паливн'],
    template: {
      label: '⛽ Характеристики паливного фільтра',
      fields: [
        { key: 'fuel_type',   label: 'Тип палива',        type: 'select', options: ['Бензин', 'Дизель'], required: true },
        { key: 'inlet_d',     label: 'Діаметр вхід',      type: 'number', unit: 'мм',  placeholder: '8' },
        { key: 'outlet_d',    label: 'Діаметр вихід',     type: 'number', unit: 'мм',  placeholder: '8' },
        { key: 'max_pres',    label: 'Макс. тиск',        type: 'number', unit: 'бар', placeholder: '5' },
      ],
    },
  },
  {
    match: ['фільтр салон'],
    template: {
      label: '🌿 Характеристики салонного фільтра',
      fields: [
        { key: 'length',      label: 'Довжина',           type: 'number', unit: 'мм',  placeholder: '220' },
        { key: 'width',       label: 'Ширина',            type: 'number', unit: 'мм',  placeholder: '195' },
        { key: 'height',      label: 'Висота',            type: 'number', unit: 'мм',  placeholder: '30' },
        { key: 'activated',   label: 'Активоване вугілля',type: 'select', options: ['Ні', 'Так'] },
      ],
    },
  },
  {
    match: ['гальмівні колодк'],
    template: {
      label: '🛑 Характеристики гальмівних колодок',
      fields: [
        { key: 'axle',        label: 'Вісь',              type: 'select', options: ['Передня', 'Задня'], required: true },
        { key: 'material',    label: 'Матеріал',          type: 'select', options: ['Органіка', 'Напівметалева', 'Кераміка'] },
        { key: 'width',       label: 'Ширина',            type: 'number', unit: 'мм',  placeholder: '55' },
        { key: 'height',      label: 'Висота',            type: 'number', unit: 'мм',  placeholder: '45' },
        { key: 'thickness',   label: 'Товщина',           type: 'number', unit: 'мм',  placeholder: '17' },
        { key: 'with_sensor', label: 'З датчиком зносу',  type: 'select', options: ['Ні', 'Так'] },
      ],
    },
  },
  {
    match: ['гальмівні диск'],
    template: {
      label: '⭕ Характеристики гальмівного диска',
      fields: [
        { key: 'axle',        label: 'Вісь',              type: 'select', options: ['Передня', 'Задня'], required: true },
        { key: 'diameter',    label: 'Діаметр',           type: 'number', unit: 'мм',  placeholder: '280', required: true },
        { key: 'thickness',   label: 'Товщина нова',      type: 'number', unit: 'мм',  placeholder: '24' },
        { key: 'min_thick',   label: 'Мін. товщина',      type: 'number', unit: 'мм',  placeholder: '21' },
        { key: 'hole_count',  label: 'К-сть отворів',     type: 'number', placeholder: '5' },
        { key: 'type',        label: 'Тип',               type: 'select', options: ['Суцільний', 'Вентильований', 'Перфорований', 'З насічками'] },
      ],
    },
  },
  {
    match: ['свічк'],
    template: {
      label: '⚡ Характеристики свічки запалювання',
      fields: [
        { key: 'thread',      label: 'Різьба',            type: 'select', options: ['M10','M12','M14','M18'], required: true },
        { key: 'hex',         label: 'Ключ',              type: 'select', options: ['14мм','16мм','21мм'] },
        { key: 'gap',         label: 'Зазор',             type: 'number', unit: 'мм',  placeholder: '0.8' },
        { key: 'reach',       label: 'Довжина різьби',    type: 'number', unit: 'мм',  placeholder: '19' },
        { key: 'electrode',   label: 'Матеріал електрода',type: 'select', options: ['Нікель', 'Платина', 'Іридій', 'Подвійний платина', 'Іридій+платина'] },
        { key: 'heat_range',  label: 'Калильне число',    type: 'number', placeholder: '6' },
      ],
    },
  },
  {
    match: ['амортизатор'],
    template: {
      label: '🌀 Характеристики амортизатора',
      fields: [
        { key: 'axle',        label: 'Вісь',              type: 'select', options: ['Передня', 'Задня'], required: true },
        { key: 'side',        label: 'Сторона',           type: 'select', options: ['Ліва', 'Права', 'Ліва/Права'] },
        { key: 'type',        label: 'Тип',               type: 'select', options: ['Масляний', 'Газовий', 'Газомасляний', 'Пневматичний'] },
        { key: 'length_min',  label: 'Довжина стиснутий', type: 'number', unit: 'мм',  placeholder: '300' },
        { key: 'length_max',  label: 'Довжина розтягнут.', type: 'number', unit: 'мм', placeholder: '450' },
        { key: 'upper_mount', label: 'Верхнє кріплення',  type: 'select', options: ['Штир', 'Вухо', 'Ковзаюче'] },
        { key: 'lower_mount', label: 'Нижнє кріплення',   type: 'select', options: ['Штир', 'Вухо'] },
      ],
    },
  },
  {
    match: ['ремін', 'ланцюг', 'грм'],
    template: {
      label: '⚙️ Характеристики ременя/ланцюга ГРМ',
      fields: [
        { key: 'type',        label: 'Тип',               type: 'select', options: ['Ремінь', 'Ланцюг'], required: true },
        { key: 'teeth',       label: 'К-сть зубів',       type: 'number', placeholder: '131' },
        { key: 'width',       label: 'Ширина',            type: 'number', unit: 'мм',  placeholder: '25' },
        { key: 'length',      label: 'Довжина',           type: 'number', unit: 'мм',  placeholder: '1050' },
        { key: 'material',    label: 'Матеріал',          type: 'select', options: ['Гума', 'HNBR', 'HSN'] },
      ],
    },
  },
]

/** Повертає шаблон характеристик для назви категорії, або null */
export function getSpecTemplate(categoryName: string): SpecTemplate | null {
  if (!categoryName) return null
  const lower = categoryName.toLowerCase()
  for (const { match, template } of TEMPLATES) {
    if (match.some((m) => lower.includes(m))) return template
  }
  return null
}
