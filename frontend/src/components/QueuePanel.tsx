import { useState } from 'react'
import { createPortal } from 'react-dom'
import { GripVertical, Radio, X } from 'lucide-react'
import clsx from 'clsx'
import { faNumerals, useMessages } from '../lib/i18n'
import { usePlayer, type QueueItem } from '../lib/player'
import { Artwork, PlayingBars } from './Artwork'

function Row({
  item,
  active,
  playing,
  children,
}: {
  item: QueueItem
  active?: boolean
  playing?: boolean
  children?: React.ReactNode
}) {
  const m = useMessages()
  return (
    <>
      <Artwork
        src={item.coverUrl}
        hasCover={item.hasCover ?? Boolean(item.coverUrl)}
        className="size-9"
        iconClassName="size-4"
        overlay={
          active && playing ? (
            <span className="absolute inset-0 grid place-items-center bg-black/60">
              <PlayingBars className="h-3 text-lime-flash" />
            </span>
          ) : undefined
        }
      />
      <span className="min-w-0 flex-1">
        <span
          className={clsx(
            'block truncate text-mini font-semibold',
            active ? 'text-lime-flash' : 'text-ink-100',
            faNumerals(item.title),
          )}
          dir="auto"
        >
          {item.title}
        </span>
        <span
          className="mt-0.5 flex items-center gap-1 truncate text-[11px] text-ink-500"
          dir="auto"
        >
          {item.online && (
            <Radio className="size-3 shrink-0 text-ink-500" aria-label={m.player.online} />
          )}
          <span className={clsx('truncate', faNumerals(item.artist))}>
            {item.artist || m.player.unknownArtist}
          </span>
        </span>
      </span>
      {children}
    </>
  )
}

/** What plays next, in the order it will play — shuffled or not. Songs can
 *  be dragged into a new order, dropped, or jumped to. */
export function QueuePanel({ onClose }: { onClose: () => void }) {
  const m = useMessages()
  const { queue, order, index, current, playing, playAt, removeAt, moveInOrder, clearUpcoming } =
    usePlayer()
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [dragOver, setDragOver] = useState<number | null>(null)

  const pos = order.indexOf(index)
  const upcoming =
    pos === -1 ? [] : order.slice(pos + 1).map((at, k) => ({ at, slot: pos + 1 + k }))

  // Portalled out of the player bar: its backdrop blur makes it the
  // containing block for anything `fixed` inside it, which would pin this
  // panel to the bar instead of the window.
  return createPortal(
    <aside
      aria-label={m.player.queue}
      className="fixed bottom-[4.25rem] end-3 top-12 z-50 flex w-[22rem] max-w-[calc(100vw-1.5rem)] animate-fade-up flex-col overflow-hidden rounded-panel border border-white/[0.08] bg-[#0f120d]/97 shadow-2xl shadow-black/60 backdrop-blur-xl"
    >
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-white/[0.06] px-4">
        <h2 className="font-display text-sm font-bold text-ink-100">{m.player.queue}</h2>
        <div className="flex items-center gap-1">
          {upcoming.length > 0 && (
            <button
              type="button"
              onClick={clearUpcoming}
              className="rounded-ctl px-2 py-1 text-micro font-semibold text-ink-400 transition hover:bg-white/[0.06] hover:text-ink-100"
            >
              {m.player.clearQueue}
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label={m.player.closeQueue}
            className="grid size-8 place-items-center rounded-full text-ink-400 transition hover:bg-white/[0.06] hover:text-ink-100"
          >
            <X className="size-4" />
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {current && (
          <>
            <p className="px-2 pb-1.5 pt-1 text-[10px] font-semibold text-ink-500">
              {m.player.nowPlaying}
            </p>
            <div className="flex items-center gap-3 rounded-ctl bg-lime-flash/[0.07] p-2">
              <Row item={current} active playing={playing} />
            </div>
          </>
        )}

        <p className="px-2 pb-1.5 pt-4 text-[10px] font-semibold text-ink-500">{m.player.upNext}</p>
        {upcoming.length === 0 ? (
          <p className="px-2 py-3 text-mini text-ink-500">{m.player.queueEmpty}</p>
        ) : (
          <ol>
            {upcoming.map(({ at, slot }) => {
              const item = queue[at]
              return (
                <li
                  key={`${item.id}-${at}`}
                  draggable
                  onDragStart={(e) => {
                    setDragFrom(slot)
                    e.dataTransfer.effectAllowed = 'move'
                  }}
                  onDragOver={(e) => {
                    if (dragFrom === null) return
                    e.preventDefault()
                    setDragOver(slot)
                  }}
                  onDragEnd={() => {
                    setDragFrom(null)
                    setDragOver(null)
                  }}
                  onDrop={(e) => {
                    e.preventDefault()
                    if (dragFrom !== null) moveInOrder(dragFrom, slot)
                    setDragFrom(null)
                    setDragOver(null)
                  }}
                  className={clsx(
                    'group flex items-center gap-2 rounded-ctl p-2 transition',
                    dragOver === slot && dragFrom !== slot
                      ? 'bg-lime-flash/[0.08] ring-1 ring-lime-flash/30'
                      : 'hover:bg-white/[0.04]',
                    dragFrom === slot && 'opacity-40',
                  )}
                >
                  <GripVertical
                    className="size-3.5 shrink-0 cursor-grab text-ink-600 group-hover:text-ink-400"
                    aria-label={m.player.dragToReorder}
                  />
                  <button
                    type="button"
                    onClick={() => playAt(at)}
                    className="flex min-w-0 flex-1 items-center gap-3 text-start"
                  >
                    <Row item={item} />
                  </button>
                  <button
                    type="button"
                    onClick={() => removeAt(at)}
                    aria-label={m.player.removeFromQueue(item.title)}
                    className="grid size-7 shrink-0 place-items-center rounded-full text-ink-500 opacity-0 transition hover:bg-white/[0.06] hover:text-ink-100 focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <X className="size-3.5" />
                  </button>
                </li>
              )
            })}
          </ol>
        )}
      </div>
    </aside>,
    document.body,
  )
}
