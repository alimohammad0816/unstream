import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { PlaylistTrackInput } from './api'

/** One playable row: a library file or a streamed song, with everything the
 *  bar and the karaoke view need without asking the backend again. */
export interface QueueItem {
  id: string
  title: string
  artist: string
  album: string
  duration_ms: number
  url: string
  coverUrl?: string
  hasCover?: boolean
  /** Played through `/api/stream` rather than from a file on disk. It fails
   *  differently — nothing moved, the song just couldn't be found — and the
   *  player warms the next one up while this one plays. */
  online?: boolean
  /** The song as a playlist would keep it, so whatever is playing can be
   *  saved from the bar or the queue without knowing where it came from. */
  song?: PlaylistTrackInput
}

export type RepeatMode = 'off' | 'all' | 'one'

interface PlayerContextValue {
  queue: QueueItem[]
  index: number
  current: QueueItem | null
  playing: boolean
  loading: boolean
  failed: boolean
  shuffle: boolean
  repeat: RepeatMode
  /** Play order as indices into `queue` — identity unless shuffled. What the
   *  queue panel lists as "up next". */
  order: number[]
  playQueue: (items: QueueItem[], startIndex: number) => void
  playAt: (index: number) => void
  /** Queue songs to play right after the current one. */
  playNext: (items: QueueItem[]) => void
  /** Queue songs at the end. Starts playing when nothing is queued. */
  addToQueue: (items: QueueItem[]) => void
  /** Drop one queued song by its index in `queue`. Never the current one. */
  removeAt: (index: number) => void
  /** Move a song within the play order, by position in `order`. */
  moveInOrder: (from: number, to: number) => void
  /** Drop everything after the current song in play order. */
  clearUpcoming: () => void
  toggle: () => void
  next: () => void
  prev: () => void
  seekTo: (seconds: number) => void
  seekBy: (delta: number) => void
  toggleShuffle: () => void
  cycleRepeat: () => void
  stop: () => void
}

/** Position, kept apart from everything else on purpose.
 *
 *  `timeupdate` fires ~4× a second. Behind one context that would re-render
 *  every consumer of the player — the whole desktop shell — four times a
 *  second for a number only the scrubber and the lyric roll care about.
 *  Splitting it means the sidebar, the library list and the track rows
 *  render when the *track* changes and never on a tick. */
interface PlayerTimeValue {
  time: number
  duration: number
}

/** The element itself, for the one caller that needs the playhead sooner
 *  than `timeupdate` offers it. See `useAudioClock`. */
const PlayerAudioContext = createContext<{ current: HTMLAudioElement | null } | null>(null)

/** Volume, split off for the same reason as position: dragging the slider
 *  fires continuously, and the library list has no stake in the result. */
interface PlayerVolumeValue {
  volume: number
  muted: boolean
  setVolume: (value: number) => void
  toggleMute: () => void
}

const PlayerContext = createContext<PlayerContextValue | null>(null)
const PlayerTimeContext = createContext<PlayerTimeValue>({ time: 0, duration: 0 })
const PlayerVolumeContext = createContext<PlayerVolumeValue | null>(null)

const VOLUME_KEY = 'unstream:volume'
const MUTED_KEY = 'unstream:muted'
const SHUFFLE_KEY = 'unstream:shuffle'
const REPEAT_KEY = 'unstream:repeat'
const SESSION_KEY = 'unstream:session'

/** What was playing when the app closed: the queue, the song, and how far
 *  in. Restored paused — reopening the app is not a request for sound. */
interface Session {
  queue: QueueItem[]
  index: number
  time: number
}

function storedSession(): Session | null {
  return stored<Session | null>(
    SESSION_KEY,
    (raw) => {
      const parsed = JSON.parse(raw) as Partial<Session>
      if (!Array.isArray(parsed.queue) || parsed.queue.length === 0) return null
      const valid = parsed.queue.every(
        (item) => item && typeof item.id === 'string' && typeof item.url === 'string',
      )
      if (!valid) return null
      const index = Number(parsed.index)
      if (!Number.isInteger(index) || index < 0 || index >= parsed.queue.length) return null
      const time = Number(parsed.time)
      return { queue: parsed.queue, index, time: Number.isFinite(time) && time > 0 ? time : 0 }
    },
    null,
  )
}

const identity = (length: number) => Array.from({ length }, (_, i) => i)

/** Where `items` land in the queue array when spliced in at `at`, and the
 *  old indices shifted past them. */
function spliceIn(queue: QueueItem[], order: number[], at: number, items: QueueItem[]) {
  const n = items.length
  return {
    queue: [...queue.slice(0, at), ...items, ...queue.slice(at)],
    order: order.map((i) => (i >= at ? i + n : i)),
    added: Array.from({ length: n }, (_, k) => at + k),
  }
}

function stored<T>(key: string, parse: (raw: string) => T | null, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return fallback
    const parsed = parse(raw)
    return parsed === null ? fallback : parsed
  } catch {
    return fallback
  }
}

function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // A private window refuses; the setting just doesn't outlive the session.
  }
}

/** Fisher–Yates over indices, with `first` pulled to the front — shuffling
 *  from a track the person just picked has to keep playing that track. */
function shuffledOrder(length: number, first: number): number[] {
  const order = Array.from({ length }, (_, i) => i)
  for (let i = length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[order[i], order[j]] = [order[j], order[i]]
  }
  const at = order.indexOf(first)
  if (at > 0) [order[0], order[at]] = [order[at], order[0]]
  return order
}

/** Full-track player for the on-disk library and for streamed songs. One
 *  Audio element per session, like preview.ts — starting a track stops the
 *  previous one. Mounted in the desktop shell only; the web keeps previews. */
export function PlayerProvider({ children }: { children: ReactNode }) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [restored] = useState(storedSession)
  const [queue, setQueue] = useState<QueueItem[]>(() => restored?.queue ?? [])
  const [index, setIndex] = useState(() => restored?.index ?? 0)
  const [order, setOrder] = useState<number[]>(() => identity(restored?.queue.length ?? 0))
  const [playing, setPlaying] = useState(false)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [time, setTime] = useState(() => restored?.time ?? 0)
  const [duration, setDuration] = useState(() => {
    const item = restored?.queue[restored.index]
    return item && item.duration_ms > 0 ? item.duration_ms / 1000 : 0
  })
  const [shuffle, setShuffle] = useState(() => stored(SHUFFLE_KEY, (raw) => raw === '1', false))
  const [repeat, setRepeat] = useState<RepeatMode>(() =>
    stored<RepeatMode>(
      REPEAT_KEY,
      (raw) => (raw === 'all' || raw === 'one' || raw === 'off' ? raw : null),
      'off',
    ),
  )
  const [volume, setVolumeState] = useState(() =>
    stored(
      VOLUME_KEY,
      (raw) => {
        const n = Number(raw)
        return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null
      },
      1,
    ),
  )
  const [muted, setMuted] = useState(() => stored(MUTED_KEY, (raw) => raw === '1', false))
  // Read by `playQueue` when it first builds the element. Keeping them out
  // of its dependency list is what stops a volume drag from rebuilding the
  // whole player context.
  const levelRef = useRef({ volume, muted })
  levelRef.current = { volume, muted }

  const queueRef = useRef(queue)
  queueRef.current = queue
  const indexRef = useRef(index)
  indexRef.current = index
  const repeatRef = useRef(repeat)
  repeatRef.current = repeat
  // Play order as indices into `queue`: identity when shuffle is off, a
  // permutation when it's on. Keeping the queue itself in listed order is
  // what lets the library view highlight the right row either way.
  const orderRef = useRef<number[]>(order)
  const shuffleRef = useRef(shuffle)
  shuffleRef.current = shuffle
  // A restored session's position, applied once the song's metadata is in —
  // seeking an element with nothing loaded is silently ignored.
  const pendingSeekRef = useRef<number | null>(restored?.time || null)
  const savedAtRef = useRef(0)
  const ensureAudioRef = useRef<() => HTMLAudioElement>(() => {
    throw new Error('player not mounted')
  })

  /** Every structural change to the queue goes through here, so the refs the
   *  audio callbacks read and the state the UI renders never disagree. */
  const commit = useCallback((nextQueue: QueueItem[], nextOrder: number[], nextIndex: number) => {
    queueRef.current = nextQueue
    orderRef.current = nextOrder
    indexRef.current = nextIndex
    setQueue(nextQueue)
    setOrder(nextOrder)
    setIndex(nextIndex)
  }, [])

  const load = useCallback((at: number, autoplay: boolean) => {
    const q = queueRef.current
    if (at < 0 || at >= q.length) return
    const el = ensureAudioRef.current()
    const item = q[at]
    indexRef.current = at
    setIndex(at)
    setTime(0)
    setFailed(false)
    setDuration(item.duration_ms > 0 ? item.duration_ms / 1000 : 0)
    if (autoplay) setLoading(true)
    el.src = item.url
    if (autoplay) void el.play().catch(() => setLoading(false))
  }, [])

  const loadRef = useRef(load)
  loadRef.current = load

  /** The next index in play order, or null at the end of a non-repeating
   *  queue. `manual` means a person pressed Next: repeat-one then means
   *  "again" only for the natural end of a track, never for a button. */
  const step = useCallback((delta: number, manual: boolean): number | null => {
    const q = queueRef.current
    if (q.length === 0) return null
    if (!manual && repeatRef.current === 'one') return indexRef.current
    const order = orderRef.current
    const pos = order.indexOf(indexRef.current)
    if (pos === -1) return null
    const at = pos + delta
    if (at < 0 || at >= order.length) {
      if (repeatRef.current === 'all') {
        return order[(at + order.length) % order.length]
      }
      return null
    }
    return order[at]
  }, [])

  const ensureAudio = useCallback(() => {
    if (audioRef.current) return audioRef.current
    const el = new Audio()
    el.preload = 'metadata'
    el.volume = levelRef.current.volume
    el.muted = levelRef.current.muted
    el.addEventListener('timeupdate', () => {
      setTime(el.currentTime)
      // The position is worth keeping, but not at four writes a second.
      if (Math.abs(el.currentTime - savedAtRef.current) >= 5) {
        savedAtRef.current = el.currentTime
        saveSessionRef.current()
      }
    })
    el.addEventListener('loadedmetadata', () => {
      const at = pendingSeekRef.current
      pendingSeekRef.current = null
      if (at && Number.isFinite(el.duration) && at < el.duration - 1) el.currentTime = at
    })
    el.addEventListener('durationchange', () => {
      if (Number.isFinite(el.duration)) setDuration(el.duration)
    })
    el.addEventListener('playing', () => {
      setPlaying(true)
      setLoading(false)
      setFailed(false)
    })
    el.addEventListener('pause', () => {
      setPlaying(false)
      saveSessionRef.current()
    })
    el.addEventListener('waiting', () => setLoading(true))
    el.addEventListener('error', () => {
      // A file deleted or renamed under us. Say so rather than looking
      // stuck, and don't march through the rest of the queue failing.
      setPlaying(false)
      setLoading(false)
      setFailed(true)
    })
    el.addEventListener('ended', () => {
      const at = step(1, false)
      if (at === null) {
        setPlaying(false)
        setTime(0)
        return
      }
      if (at === indexRef.current) {
        el.currentTime = 0
        void el.play().catch(() => {})
        return
      }
      loadRef.current(at, true)
    })
    audioRef.current = el
    return el
  }, [step])
  ensureAudioRef.current = ensureAudio

  const saveSession = useCallback(() => {
    const q = queueRef.current
    if (q.length === 0) {
      try {
        localStorage.removeItem(SESSION_KEY)
      } catch {
        // nothing to forget
      }
      return
    }
    const session: Session = {
      queue: q,
      index: indexRef.current,
      time: audioRef.current?.currentTime ?? pendingSeekRef.current ?? 0,
    }
    remember(SESSION_KEY, JSON.stringify(session))
  }, [])
  const saveSessionRef = useRef(saveSession)
  saveSessionRef.current = saveSession

  useEffect(() => {
    saveSession()
  }, [queue, index, saveSession])

  // Volume and mute live in React state and are pushed to the element, so a
  // slider, the mute button and a restored session all take the same path.
  useEffect(() => {
    const el = audioRef.current
    if (el) {
      el.volume = volume
      el.muted = muted
    }
    remember(VOLUME_KEY, String(volume))
    remember(MUTED_KEY, muted ? '1' : '0')
  }, [volume, muted])

  const playQueue = useCallback(
    (items: QueueItem[], startIndex: number) => {
      if (items.length === 0) return
      const at = Math.min(Math.max(0, startIndex), items.length - 1)
      pendingSeekRef.current = null
      commit(items, shuffle ? shuffledOrder(items.length, at) : identity(items.length), at)
      load(at, true)
    },
    [commit, load, shuffle],
  )

  const playAt = useCallback(
    (at: number) => {
      pendingSeekRef.current = null
      load(at, true)
    },
    [load],
  )

  const playNext = useCallback(
    (items: QueueItem[]) => {
      if (items.length === 0) return
      const q = queueRef.current
      if (q.length === 0) {
        playQueue(items, 0)
        return
      }
      const current = indexRef.current
      const spliced = spliceIn(q, orderRef.current, current + 1, items)
      const pos = spliced.order.indexOf(current)
      const nextOrder = [
        ...spliced.order.slice(0, pos + 1),
        ...spliced.added,
        ...spliced.order.slice(pos + 1),
      ]
      commit(spliced.queue, nextOrder, current)
    },
    [commit, playQueue],
  )

  const addToQueue = useCallback(
    (items: QueueItem[]) => {
      if (items.length === 0) return
      const q = queueRef.current
      if (q.length === 0) {
        playQueue(items, 0)
        return
      }
      const spliced = spliceIn(q, orderRef.current, q.length, items)
      commit(spliced.queue, [...spliced.order, ...spliced.added], indexRef.current)
    },
    [commit, playQueue],
  )

  const removeAt = useCallback(
    (at: number) => {
      const q = queueRef.current
      const current = indexRef.current
      if (at < 0 || at >= q.length || at === current) return
      commit(
        q.filter((_, i) => i !== at),
        orderRef.current.filter((i) => i !== at).map((i) => (i > at ? i - 1 : i)),
        at < current ? current - 1 : current,
      )
    },
    [commit],
  )

  const moveInOrder = useCallback(
    (from: number, to: number) => {
      const q = queueRef.current
      const o = orderRef.current
      if (from === to || from < 0 || to < 0 || from >= o.length || to >= o.length) return
      if (shuffleRef.current) {
        // Shuffled: the play order is its own list, so only it moves.
        const nextOrder = [...o]
        const [moved] = nextOrder.splice(from, 1)
        nextOrder.splice(to, 0, moved)
        commit(q, nextOrder, indexRef.current)
        return
      }
      // In order: the queue itself moves, and the order stays the identity
      // it has to be for turning shuffle off to mean "back to the list".
      const nextQueue = [...q]
      const [moved] = nextQueue.splice(from, 1)
      nextQueue.splice(to, 0, moved)
      const currentItem = q[indexRef.current]
      commit(nextQueue, identity(nextQueue.length), nextQueue.indexOf(currentItem))
    },
    [commit],
  )

  const clearUpcoming = useCallback(() => {
    const q = queueRef.current
    const o = orderRef.current
    const pos = o.indexOf(indexRef.current)
    if (pos === -1) return
    const keep = new Set(o.slice(0, pos + 1))
    const kept = q.map((_, i) => i).filter((i) => keep.has(i))
    const remap = new Map(kept.map((old, i) => [old, i]))
    commit(
      kept.map((i) => q[i]),
      o.slice(0, pos + 1).map((i) => remap.get(i)!),
      remap.get(indexRef.current)!,
    )
  }, [commit])

  const toggle = useCallback(() => {
    if (queueRef.current.length === 0) return
    const el = audioRef.current
    // A restored session has a queue but nothing loaded yet: the first press
    // loads the song and picks up where it was left.
    if (!el || !el.getAttribute('src')) {
      load(indexRef.current, true)
      return
    }
    if (el.paused) void el.play().catch(() => {})
    else el.pause()
  }, [load])

  const next = useCallback(() => {
    const at = step(1, true)
    if (at !== null) {
      pendingSeekRef.current = null
      load(at, true)
    }
  }, [step, load])

  const prev = useCallback(() => {
    // A tap early in the song restarts it, like every music app; deeper in,
    // Prev means the previous track. The 3-second line is the convention.
    const el = audioRef.current
    if (el && el.currentTime > 3) {
      el.currentTime = 0
      setTime(0)
      return
    }
    const at = step(-1, true)
    if (at !== null) {
      pendingSeekRef.current = null
      load(at, true)
    } else if (el) {
      el.currentTime = 0
      setTime(0)
    }
  }, [step, load])

  const seekTo = useCallback((seconds: number) => {
    const el = audioRef.current
    if (!el || !el.getAttribute('src')) {
      // Nothing loaded yet (a restored session): remember it for the load.
      pendingSeekRef.current = Math.max(0, seconds)
      setTime(Math.max(0, seconds))
      return
    }
    const limit = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : seconds
    el.currentTime = Math.max(0, Math.min(limit, seconds))
    setTime(el.currentTime)
  }, [])

  const seekBy = useCallback(
    (delta: number) => seekTo((audioRef.current?.currentTime ?? 0) + delta),
    [seekTo],
  )

  const setVolume = useCallback((value: number) => {
    const clamped = Math.max(0, Math.min(1, value))
    setVolumeState(clamped)
    // Nudging the slider up off zero is an unmute, not a silent no-op.
    if (clamped > 0) setMuted(false)
  }, [])

  const toggleMute = useCallback(() => setMuted((m) => !m), [])

  const toggleShuffle = useCallback(() => {
    setShuffle((on) => {
      const nextOn = !on
      remember(SHUFFLE_KEY, nextOn ? '1' : '0')
      const q = queueRef.current
      const nextOrder = nextOn ? shuffledOrder(q.length, indexRef.current) : identity(q.length)
      orderRef.current = nextOrder
      setOrder(nextOrder)
      return nextOn
    })
  }, [])

  const cycleRepeat = useCallback(() => {
    setRepeat((mode) => {
      const nextMode: RepeatMode = mode === 'off' ? 'all' : mode === 'all' ? 'one' : 'off'
      remember(REPEAT_KEY, nextMode)
      return nextMode
    })
  }, [])

  const stop = useCallback(() => {
    const el = audioRef.current
    if (el) {
      el.pause()
      el.removeAttribute('src')
      el.load()
    }
    pendingSeekRef.current = null
    commit([], [], 0)
    setPlaying(false)
    setFailed(false)
    setTime(0)
    setDuration(0)
  }, [commit])

  const current = queue[index] ?? null

  // Streaming a song costs seconds of searching before the first byte, so
  // the next one is resolved while this one plays. HEAD does the search and
  // fills the backend's cache without moving any audio.
  const upcoming = (() => {
    const pos = order.indexOf(index)
    const at = pos === -1 ? null : (order[pos + 1] ?? (repeat === 'all' ? order[0] : null))
    return at == null ? null : (queue[at] ?? null)
  })()
  const upcomingUrl = upcoming?.online ? upcoming.url : null
  useEffect(() => {
    if (!playing || !upcomingUrl) return
    const timer = window.setTimeout(() => {
      void fetch(upcomingUrl, { method: 'HEAD' }).catch(() => {})
    }, 4000)
    return () => window.clearTimeout(timer)
  }, [playing, upcomingUrl])

  // The OS now-playing panel and the keyboard's media keys. Without this the
  // play/pause key does nothing and macOS shows the browser's own name where
  // the song should be.
  useEffect(() => {
    const ms = navigator.mediaSession
    if (!ms) return
    if (!current) {
      ms.metadata = null
      ms.playbackState = 'none'
      return
    }
    ms.metadata = new MediaMetadata({
      title: current.title,
      artist: current.artist || '',
      album: current.album || '',
      artwork: current.coverUrl
        ? [{ src: current.coverUrl, sizes: '512x512', type: 'image/jpeg' }]
        : [],
    })
    ms.playbackState = playing ? 'playing' : 'paused'
  }, [current, playing])

  useEffect(() => {
    const ms = navigator.mediaSession
    if (!ms) return
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ['play', () => toggle()],
      ['pause', () => toggle()],
      ['previoustrack', () => prev()],
      ['nexttrack', () => next()],
      ['seekbackward', () => seekBy(-10)],
      ['seekforward', () => seekBy(10)],
      ['seekto', (details) => details.seekTime != null && seekTo(details.seekTime)],
      ['stop', () => stop()],
    ]
    for (const [action, handler] of handlers) {
      try {
        ms.setActionHandler(action, handler)
      } catch {
        // Older webviews don't know every action; the rest still bind.
      }
    }
    return () => {
      for (const [action] of handlers) {
        try {
          ms.setActionHandler(action, null)
        } catch {
          // ignore
        }
      }
    }
  }, [toggle, prev, next, seekBy, seekTo, stop])

  // Pause on the way out so a closing window doesn't leave audio running
  // while the webview tears down.
  useEffect(() => () => audioRef.current?.pause(), [])

  const value = useMemo(
    () => ({
      queue,
      index,
      current,
      playing,
      loading,
      failed,
      shuffle,
      repeat,
      order,
      playQueue,
      playAt,
      playNext,
      addToQueue,
      removeAt,
      moveInOrder,
      clearUpcoming,
      toggle,
      next,
      prev,
      seekTo,
      seekBy,
      toggleShuffle,
      cycleRepeat,
      stop,
    }),
    [
      queue,
      index,
      current,
      playing,
      loading,
      failed,
      shuffle,
      repeat,
      order,
      playQueue,
      playAt,
      playNext,
      addToQueue,
      removeAt,
      moveInOrder,
      clearUpcoming,
      toggle,
      next,
      prev,
      seekTo,
      seekBy,
      toggleShuffle,
      cycleRepeat,
      stop,
    ],
  )

  const timeValue = useMemo(() => ({ time, duration }), [time, duration])
  const volumeValue = useMemo(
    () => ({ volume, muted, setVolume, toggleMute }),
    [volume, muted, setVolume, toggleMute],
  )

  return (
    <PlayerContext.Provider value={value}>
      <PlayerAudioContext.Provider value={audioRef}>
        <PlayerVolumeContext.Provider value={volumeValue}>
          <PlayerTimeContext.Provider value={timeValue}>{children}</PlayerTimeContext.Provider>
        </PlayerVolumeContext.Provider>
      </PlayerAudioContext.Provider>
    </PlayerContext.Provider>
  )
}

export function usePlayer(): PlayerContextValue {
  const ctx = useContext(PlayerContext)
  if (!ctx) throw new Error('usePlayer must be used inside <PlayerProvider>')
  return ctx
}

/** The player when there is one. Components shared with the web shell —
 *  an album's track list, say — offer full playback only on the desktop,
 *  where the provider is mounted, and keep the 30-second preview elsewhere. */
export function useOptionalPlayer(): PlayerContextValue | null {
  return useContext(PlayerContext)
}

/** Subscribe to the playhead alone. Anything that renders per tick — the
 *  scrubber, the clock, the lyric roll — reads here so the rest of the tree
 *  stays still. */
export function usePlayerTime(): PlayerTimeValue {
  return useContext(PlayerTimeContext)
}

/** The playhead, read per animation frame instead of per `timeupdate`.
 *
 *  `timeupdate` fires roughly four times a second, so a lyric keyed off it
 *  lights up to 250ms after the line is sung — enough to read as out of time
 *  on anything with a beat. This polls the element directly while it plays
 *  and hands back a number a frame old at worst.
 *
 *  It costs a render per frame, which is why it is a separate hook and not
 *  the default: only the lyric roll asks for it, and only while karaoke is
 *  open. Everything else stays on `usePlayerTime`.
 *
 *  Falls back to the context value when there is no element yet, so the
 *  first frame after mount is the real position rather than zero.
 */
export function useAudioClock(): number {
  const ref = useContext(PlayerAudioContext)
  const { time: coarse } = usePlayerTime()
  const [time, setTime] = useState(coarse)

  useEffect(() => {
    if (!ref) return
    let frame = 0
    const tick = () => {
      const el = ref.current
      // Same value while paused, and React bails out of an identical state
      // write — so a paused song costs the loop and nothing else.
      if (el) setTime(el.currentTime)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [ref])

  return ref?.current ? time : coarse
}

/** Subscribe to volume alone, so the slider is the only thing a drag
 *  re-renders. */
export function usePlayerVolume(): PlayerVolumeValue {
  const ctx = useContext(PlayerVolumeContext)
  if (!ctx) throw new Error('usePlayerVolume must be used inside <PlayerProvider>')
  return ctx
}
