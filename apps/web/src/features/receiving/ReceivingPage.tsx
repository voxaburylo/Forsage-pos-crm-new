import { useNavigate } from 'react-router-dom'
import { FilePlus2, FileText, PackagePlus, Sparkles } from 'lucide-react'
import { Layout } from '@/components/Layout'

/**
 * «Поступлення товарів» — єдиний зрозумілий розділ для приходу товару,
 * щоб не плутати з керуванням постачальниками. Хаб із діями; самі сторінки
 * (накладна, список, новий товар) уже існують — тут лише чіткі входи.
 */
export default function ReceivingPage() {
  const navigate = useNavigate()

  const cards = [
    {
      icon: <FilePlus2 size={22} />,
      title: 'Нова накладна (приймання)',
      desc: 'Прийняти товар, прописати штрихкоди скануванням, оновити залишки',
      to: '/suppliers/invoices/new',
      accent: true,
    },
    {
      icon: <Sparkles size={22} />,
      title: 'Створити накладну з фото (AI)',
      desc: 'Додайте фото накладної — AI розпізнає товари та підготує чернетку приходу',
      to: '/receiving/ai',
    },
    {
      icon: <FileText size={22} />,
      title: 'Список накладних',
      desc: 'Усі прихідні накладні: проведення, оплати, історія',
      to: '/suppliers/invoices',
    },
    {
      icon: <PackagePlus size={22} />,
      title: 'Нова номенклатура',
      desc: 'Створити один товар вручну (без накладної)',
      to: '/products/new',
    },
  ]

  return (
    <Layout title="Поступлення товарів">
      <p className="text-sm text-gray-500 mb-5 max-w-2xl">
        Усе про прихід товару в одному місці. Оберіть дію:
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-3xl">
        {cards.map((c) => (
          <button
            key={c.to}
            onClick={() => navigate(c.to)}
            className={`text-left rounded-2xl border p-5 transition-all hover:shadow-md ${
              c.accent
                ? 'border-yellow-300 bg-yellow-50 hover:bg-yellow-100'
                : 'border-gray-200 bg-white hover:border-gray-300'
            }`}
          >
            <div
              className={`inline-flex items-center justify-center w-11 h-11 rounded-xl mb-3 ${
                c.accent ? 'bg-yellow-400 text-black' : 'bg-gray-100 text-gray-600'
              }`}
            >
              {c.icon}
            </div>
            <div className="font-semibold text-gray-900">{c.title}</div>
            <div className="text-sm text-gray-500 mt-1">{c.desc}</div>
          </button>
        ))}
      </div>
    </Layout>
  )
}
