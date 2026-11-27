import Sticker from './Sticker';
import { layoutFor, pagesOf } from './stationHelpers';

// A print job laid out as printed pages (migration 104), the way the client's
// BarTender template does it: `perPage` stickers stacked on each page,
// `gapMm` apart, with `marginMm` above the first and below the last. The roll
// on the TSC TA210 carries two stickers side by side, and one printed page is
// one such pair -- so each sticker lands on its own label.
//
// Every page is exactly widthMm x pageHeightMm, the same as the @page size the
// caller sets and the printer's paper, so Chrome has no margin left to print
// its own date, URL and page number in. A short last page keeps its empty
// slot, so the printer still feeds one whole page.
//
// `framed` is the Admin's on-screen preview: the page and each sticker are
// outlined, and the pages are spaced apart. Print CSS drops both.
export default function StickerPages({ job, framed = false }) {
  const { batch, labels, widthMm, heightMm, perPage, gapMm, marginMm, pageHeightMm } = job;
  const layout = layoutFor(widthMm, heightMm, labels[0]?.bits.length || 79);
  const pages = pagesOf(labels, perPage);
  return pages.map((page, i) => (
    <div
      key={page[0].label_key}
      className={`sticker-page${framed ? ' shadow-sm outline outline-1 outline-gray-400 bg-white' : ''}`}
      style={{
        width: `${widthMm}mm`,
        height: `${pageHeightMm}mm`,
        boxSizing: 'border-box',
        padding: `${marginMm}mm 0`,
        overflow: 'hidden',
        background: '#fff',
        display: 'flex',
        flexDirection: 'column',
        gap: `${gapMm}mm`,
        breakAfter: i === pages.length - 1 ? 'auto' : 'page',
        pageBreakAfter: i === pages.length - 1 ? 'auto' : 'always',
        marginBottom: framed ? '6mm' : 0,
      }}
    >
      {page.map((l) => (
        <Sticker
          key={l.label_key}
          batch={batch}
          label={l}
          bits={l.bits}
          widthMm={widthMm}
          heightMm={heightMm}
          layout={layout}
          framed={framed}
        />
      ))}
    </div>
  ));
}
