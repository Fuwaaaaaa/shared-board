import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import DrawLayer, { type DrawTool } from './DrawLayer'
import NotesLayer, { type LinkCounts, type ReactionMap } from './NotesLayer'
import NotesListView from './NotesListView'
import ImagesLayer from './ImagesLayer'
import AttachmentsLayer from './AttachmentsLayer'
import ConnectorsLayer from './ConnectorsLayer'
import FramesLayer from './FramesLayer'
import CursorsLayer from './CursorsLayer'
import Modal from '../../components/Modal'
import CommentList from '../../components/CommentList'
import TagInput from '../../components/TagInput'
import ConvertModal, { type ConvertPlan, type ConvertTarget } from '../../components/ConvertModal'
import BoardEmptyState from '../../components/BoardEmptyState'
import ContextMenu from '../../components/ContextMenu'
import { type CtxTarget } from '../../lib/menuTypes'
import { buildBoardMenu, type BoardMenuActions } from '../../lib/boardMenu'
import {
  buildPastedNotes,
  clipboardCount,
  getClipboardNotes,
  getClipboardStyle,
  notesToText,
  setClipboardNotes,
  setClipboardStyle,
} from '../../lib/boardClipboard'
import { buildEvent, buildTodo, originChanged, splitNoteText } from '../../lib/convert'
import { useUndoStack } from '../../hooks/useUndoStack'
import { notifyUser } from '../../hooks/useNotifications'
import { buildNameLabels } from '../../lib/names'
import { useSignedUrls } from '../../hooks/useSignedUrls'
import { useOptimisticTable, type PatchResult } from '../../hooks/useOptimisticTable'
import { useStableHandlers } from '../../hooks/useStableHandlers'
import { useMediaQuery } from '../../hooks/useMediaQuery'
import { useFocusJump } from '../../hooks/useFocusJump'
import { usePinchPan } from '../../hooks/usePinchPan'
import { supabase } from '../../lib/supabase'
import { useIdentity } from '../../lib/identity'
import { useRoomData } from '../../lib/roomData'
import { useTheme } from '../../lib/theme'
import { hasOpenModal } from '../../lib/modalStack'
import { isTypingTarget, matchShortcut, toChord } from '../../lib/shortcuts'
import { boundingBox, insideRect } from '../../lib/boardGeometry'
import { alignNotes, snapToGrid, type AlignKind } from '../../lib/boardAlign'
import { menuAnchor } from '../../lib/menuPlacement'
import { prepareImageForUpload } from '../../lib/imageResize'
import { renderBoardToBlob } from '../../lib/boardExport'
import { downloadBlob } from '../../lib/ics'
import { BOARD_TEMPLATES, type BoardTemplate } from '../../lib/templates'
import type { Peer } from '../../hooks/usePresence'
import {
  COMMENT_TARGET_LABELS,
  commentSubjectId,
  NOTE_COLORS,
  PEN_COLORS,
  PEN_COLOR_LABELS,
  type Attachment,
  type BoardImage,
  type CalendarEvent,
  type CommentSubject,
  type Connector,
  type Frame,
  type Note,
  type Todo,
  type NoteReaction,
  type NoteVote,
  type Point,
  type Stroke,
  type StrokeKind,
} from '../../lib/types'
import { attachmentIcon, formatFileSize } from '../../lib/attachmentCard'
import { messageOf } from '../../lib/errorMessage'

/**
 * 右クリックの案内を出したか。既存の localStorage の名前づけ（board.*）に合わせる。
 * 一度出したら二度と出さない ——「知らないと見つからない」を解くのが目的なので、
 * 知っている人に毎回見せる理由がない。
 */
const HINT_KEY = 'board.hintContextMenu'

const BOARD_W = 2000
const BOARD_H = 1200
const GRID = 20
const MIN_ZOOM = 0.2
const MAX_ZOOM = 2
const IMAGE_BUCKET = 'board-images'
const FILE_BUCKET = 'board-files'
/** 受け付ける元画像の大きさ。縮小してから送るので、ここは緩めでよい */
const MAX_IMAGE_ACCEPT_BYTES = 20 * 1024 * 1024
/** 縮小後にこれを超える画像は貼らない */
const MAX_IMAGE_UPLOAD_BYTES = 5 * 1024 * 1024
const MAX_FILE_BYTES = 10 * 1024 * 1024

type Mode = 'select' | 'note' | 'textbox' | 'connect' | 'frame' | DrawTool

const PLACE_TOOLS: { key: Mode; label: string; icon: string; hotkey: string }[] = [
  { key: 'select', label: '選択', icon: '🖐', hotkey: 'v' },
  { key: 'note', label: '付箋', icon: '🗒', hotkey: 'n' },
  { key: 'textbox', label: 'テキスト', icon: '🔤', hotkey: 't' },
  { key: 'connect', label: 'つなぐ', icon: '🔗', hotkey: 'c' },
  { key: 'frame', label: 'フレーム', icon: '⬚', hotkey: 'f' },
]

const DRAW_TOOLS: { key: Mode; label: string; icon: string; hotkey: string }[] = [
  { key: 'pen', label: 'ペン', icon: '✏️', hotkey: 'p' },
  { key: 'line', label: '直線', icon: '／', hotkey: 'l' },
  { key: 'arrow', label: '矢印', icon: '➔', hotkey: 'a' },
  { key: 'rect', label: '四角', icon: '▭', hotkey: 'r' },
  { key: 'ellipse', label: '円', icon: '◯', hotkey: 'o' },
  { key: 'eraser', label: '消しゴム', icon: '🧽', hotkey: 'e' },
]

const HOTKEYS = Object.fromEntries(
  [...PLACE_TOOLS, ...DRAW_TOOLS].map((t) => [t.hotkey, t.key]),
) as Record<string, Mode>

const PEN_WIDTHS = [2, 4, 8, 14]

interface Props {
  peers: Peer[]
  onCursorMove: (x: number, y: number, laser?: boolean) => void
  focusId: string | null
  focusNonce: number
  boardName: string
  onOpenShortcuts: () => void
  /** 付箋から作った やること / 予定 を、そのタブで開く */
  onJump: (tab: 'calendar' | 'todo', id: string | null) => void
  /** 共有モーダルを開く（空のボードの案内から） */
  onOpenShare: () => void
  /** 自分が本文を編集している付箋を presence に載せる（usePresence の setEditing） */
  onEditingChange: (noteId: string | null) => void
}

interface Marquee {
  x1: number
  y1: number
  x2: number
  y2: number
}

type ViewChoice = 'auto' | 'list' | 'board'

/** 右クリックメニューの読み上げ名 */
const MENU_LABELS: Record<CtxTarget['kind'], string> = {
  note: '付箋の操作',
  image: '画像の操作',
  frame: 'フレームの操作',
  connector: '線の操作',
  attachment: 'ファイルの操作',
  canvas: 'ボードの操作',
}

/** 保存できなかったら throw する。useUndoStack はそれを見てエントリを元のスタックに戻す */
async function must(result: Promise<boolean>): Promise<void> {
  if (!(await result)) throw new Error('保存できませんでした')
}

/**
 * patch 版。'conflict' は失敗扱いにしない（もう一度押しても同じ結果になる）。
 * 競合したことは useOptimisticTable が知らせるので、ここでは黙って通す。
 */
async function mustPatch(result: Promise<PatchResult>): Promise<void> {
  if ((await result) === 'error') throw new Error('保存できませんでした')
}

export default function WhiteboardTab({
  peers,
  onCursorMove,
  focusId,
  focusNonce,
  boardName,
  onOpenShortcuts,
  onJump,
  onOpenShare,
  onEditingChange,
}: Props) {
  const { userId, displayName } = useIdentity()
  const {
    roomId,
    canEdit,
    notes,
    strokes,
    images,
    attachments,
    connectors,
    frames,
    reactions,
    comments,
    votes,
    events,
    todos,
    approvedMembers,
  } = useRoomData()
  const { resolved: theme } = useTheme()
  const undoStack = useUndoStack()

  const [mode, setMode] = useState<Mode>('select')
  const [penColor, setPenColor] = useState(PEN_COLORS[0])
  const [penWidth, setPenWidth] = useState(4)
  const [zoom, setZoom] = useState(1)
  const [snap, setSnap] = useState(true)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [selectedOther, setSelectedOther] = useState<
    { kind: 'image' | 'attachment' | 'connector' | 'frame'; id: string } | null
  >(null)
  const [connectFrom, setConnectFrom] = useState<string | null>(null)
  const [marquee, setMarquee] = useState<Marquee | null>(null)
  const [commentTarget, setCommentTarget] = useState<CommentSubject | null>(null)
  const [converting, setConverting] = useState<{ notes: Note[]; target: ConvertTarget } | null>(null)
  const [showTemplates, setShowTemplates] = useState(false)
  const [showBulk, setShowBulk] = useState(false)
  const [showClearStrokes, setShowClearStrokes] = useState(false)
  const [laser, setLaser] = useState(false)
  /**
   * スマホでは付箋の一覧を既定にする。
   * ドラッグ・範囲選択・拡大縮小は指では扱いにくいため。
   * 画面の向きが変わったら追従するが、ユーザーが明示的に選んだらそちらを守る。
   */
  const [viewChoice, setViewChoice] = useState<ViewChoice>('auto')
  const narrow = useMediaQuery('(max-width: 639px)')
  const listView = viewChoice === 'auto' ? narrow : viewChoice === 'list'
  const [panning, setPanning] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  /** 2 本指の操作が始まった回数。DrawLayer に描きかけを捨てさせる */
  const [gestureNonce, setGestureNonce] = useState(0)
  /** 変換の結果。押すと作った先のタブへ飛べる */
  const [created, setCreated] = useState<{
    text: string
    tab: 'calendar' | 'todo'
    id: string
  } | null>(null)
  /**
   * 右クリックメニュー。x/y は画面上の位置、bx/by は右クリックしたボード上の座標。
   * bx/by を持っておくと「ここに付箋を作る」を画面中央ではなく実際の位置に置ける。
   */
  const [menu, setMenu] = useState<{
    x: number
    y: number
    bx: number
    by: number
    target: CtxTarget
  } | null>(null)

  const scrollRef = useRef<HTMLDivElement>(null)
  /** ズームが掛かっているボード本体。右クリック位置をボード座標に直すのに使う */
  const boardRef = useRef<HTMLDivElement>(null)
  /** キーボードからメニューを開いた時刻。contextmenu の二重発火を抑えるのに使う */
  const keyboardMenuAtRef = useRef(0)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dragOriginsRef = useRef<Map<string, { x: number; y: number }>>(new Map())
  /** ドラッグ中の付箋の x/y を、他の人のエコーから守る保留の解除関数 */
  const dragHoldsRef = useRef<Map<string, () => void>>(new Map())
  const frameDragRef = useRef<{ frame: Frame; notes: Map<string, { x: number; y: number }> } | null>(
    null,
  )
  const frameHoldsRef = useRef<(() => void)[]>([])
  const marqueeStartRef = useRef<Point | null>(null)
  const spaceRef = useRef(false)
  const panRef = useRef<{ x: number; y: number; left: number; top: number } | null>(null)

  // 各テーブルの「保留 → ローカル反映 → 送信 → 失敗なら戻す」をここに寄せる
  const noteOps = useOptimisticTable<Note>('notes', notes, setNotice, { roomId, userId })
  const strokeOps = useOptimisticTable<Stroke>('strokes', strokes, setNotice)
  const imageOps = useOptimisticTable<BoardImage>('images', images, setNotice)
  const attachmentOps = useOptimisticTable<Attachment>('attachments', attachments, setNotice)
  const connectorOps = useOptimisticTable<Connector>('connectors', connectors, setNotice)
  const frameOps = useOptimisticTable<Frame>('frames', frames, setNotice)
  const reactionOps = useOptimisticTable<NoteReaction>('note_reactions', reactions, setNotice)
  const voteOps = useOptimisticTable<NoteVote>('note_votes', votes, setNotice)
  /*
   * やること・予定は、ここからも書く（付箋からの変換）。ためる相手を渡し忘れると、
   * 同じ表なのに「ToDo タブからは送れるが、ボードからは失敗する」食い違いになる。
   */
  const todoOps = useOptimisticTable<Todo>('todos', todos, setNotice, { roomId, userId })
  const eventOps = useOptimisticTable<CalendarEvent>('events', events, setNotice, {
    roomId,
    userId,
  })

  const imagePaths = useMemo(() => images.rows.map((i) => i.storage_path), [images.rows])
  const filePaths = useMemo(() => attachments.rows.map((a) => a.storage_path), [attachments.rows])
  const imageUrls = useSignedUrls(IMAGE_BUCKET, imagePaths)
  // 添付は必ずダウンロードとして返させる（ブラウザ上で開かせない）
  const fileUrls = useSignedUrls(FILE_BUCKET, filePaths, 3600, true)

  const isDrawing = ['pen', 'eraser', 'line', 'arrow', 'rect', 'ellipse'].includes(mode)

  const selectedNotes = useMemo(
    () => notes.rows.filter((n) => selectedIds.includes(n.id)),
    [notes.rows, selectedIds],
  )

  const noteCommentCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const comment of comments.rows) {
      if (comment.target_type !== 'note' || !comment.target_id) continue
      counts[comment.target_id] = (counts[comment.target_id] ?? 0) + 1
    }
    return counts
  }, [comments.rows])

  const voteCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const vote of votes.rows) counts[vote.note_id] = (counts[vote.note_id] ?? 0) + 1
    return counts
  }, [votes.rows])

  const myVotes = useMemo(
    () => new Set(votes.rows.filter((v) => v.user_id === userId).map((v) => v.note_id)),
    [votes.rows, userId],
  )

  const reactionMap = useMemo<ReactionMap>(() => {
    const map: ReactionMap = {}
    for (const reaction of reactions.rows) {
      const forNote = (map[reaction.note_id] ??= {})
      const entry = (forNote[reaction.emoji] ??= { count: 0, mine: false })
      entry.count++
      if (reaction.user_id === userId) entry.mine = true
    }
    return map
  }, [reactions.rows, userId])

  /**
   * 付箋 → そこから生まれた やること / 予定 の件数。
   * 付箋を直したあと、まだ反映していないものは stale として数える。
   */
  const linkCounts = useMemo<LinkCounts>(() => {
    const map: LinkCounts = {}
    const noteById = new Map(notes.rows.map((note) => [note.id, note]))

    const bump = (
      source: { source_note_id: string | null; source_synced_at: string | null },
      key: 'todos' | 'events',
    ) => {
      const noteId = source.source_note_id
      if (!noteId) return
      const entry = (map[noteId] ??= { todos: 0, events: 0, stale: 0 })
      entry[key]++
      if (originChanged(source, noteById.get(noteId))) entry.stale++
    }

    for (const todo of todos.rows) bump(todo, 'todos')
    for (const event of events.rows) bump(event, 'events')
    return map
  }, [todos.rows, events.rows, notes.rows])

  /** 付箋 id → いま本文を編集している他の人の名前 */
  const editingByOthers = useMemo(() => {
    const map = new Map<string, string>()
    for (const peer of peers) {
      if (peer.userId !== userId && peer.editingNoteId) map.set(peer.editingNoteId, peer.name)
    }
    return map
  }, [peers, userId])

  const memberOptions = useMemo(() => {
    const labels = buildNameLabels(approvedMembers, userId)
    return approvedMembers.map((m) => ({
      id: m.user_id,
      name: labels.get(m.user_id) ?? m.display_name,
    }))
  }, [approvedMembers, userId])

  const allTags = useMemo(() => {
    const set = new Set<string>()
    for (const note of notes.rows) for (const tag of note.tags ?? []) set.add(tag)
    return [...set].sort((a, b) => a.localeCompare(b, 'ja'))
  }, [notes.rows])

  /** 読み込みが終わっていて、何も置かれていない */
  const boardEmpty =
    !notes.loading &&
    !strokes.loading &&
    !images.loading &&
    !frames.loading &&
    !attachments.loading &&
    notes.rows.length === 0 &&
    strokes.rows.length === 0 &&
    images.rows.length === 0 &&
    frames.rows.length === 0 &&
    attachments.rows.length === 0

  useEffect(() => {
    if (!canEdit && mode !== 'select') setMode('select')
  }, [canEdit, mode])

  useEffect(() => {
    if (mode !== 'connect') setConnectFrom(null)
  }, [mode])

  /*
   * 飛び先になりうるものを 1 つに並べる。
   *
   * コメントは付箋だけでなく画像・ファイル・フレームにも付くので、検索や通知からは
   * それらの id でも飛んでくる。付箋しか探していないと、当たりは出るのに押しても
   * 何も起きない——search.ts が liveTargets で避けようとしている、まさにその状態になる。
   * 付箋以外は選択の対象にできないので、そこまで連れていくところまでを受け持つ。
   */
  const focusTargets = useMemo(
    () => [
      ...notes.rows.map((n) => ({ id: n.id, x: n.x, y: n.y, note: true })),
      ...images.rows.map((i) => ({ id: i.id, x: i.x, y: i.y, note: false })),
      ...attachments.rows.map((a) => ({ id: a.id, x: a.x, y: a.y, note: false })),
      ...frames.rows.map((f) => ({ id: f.id, x: f.x, y: f.y, note: false })),
    ],
    [notes.rows, images.rows, attachments.rows, frames.rows],
  )

  // 検索・更新タブから飛んできたものを、画面の真ん中へ入れる
  useFocusJump(focusId, focusNonce, focusTargets, (target) => {
    const container = scrollRef.current
    // 一覧ビューには置き場所が無い。届いてからもう一度試す
    if (!container) return false

    setMode('select')
    setSelectedIds(target.note ? [target.id] : [])
    container.scrollTo({
      left: Math.max(0, target.x * zoom - container.clientWidth / 2),
      top: Math.max(0, target.y * zoom - container.clientHeight / 2),
      behavior: 'smooth',
    })
  })

  /*
   * 右クリックのメニューは、あることを知らないと一生見つからない。
   * 最初の一度だけ知らせる。
   *
   * 空のボードでは出さない（触る対象がまだ無い）。スマホの一覧ビューでも出さない
   * （右クリックできないうえ、そちらには「⋮」がある）。
   */
  useEffect(() => {
    if (listView || !canEdit || notes.rows.length === 0) return
    try {
      if (localStorage.getItem(HINT_KEY)) return
      localStorage.setItem(HINT_KEY, '1')
    } catch {
      // プライベートモードなどで使えないときは、毎回出るより出ないほうがましなので黙る
      return
    }
    setNotice('付箋を右クリックすると、コピーや複製などの操作が出せます')
  }, [listView, canEdit, notes.rows.length])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), 4000)
    return () => window.clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    if (!created) return
    const timer = window.setTimeout(() => setCreated(null), 8000)
    return () => window.clearTimeout(timer)
  }, [created])

  // ---- 表示位置 -----------------------------------------------------------

  /** ボード全体が画面に収まる倍率にして、左上へ戻す */
  const fitToScreen = useCallback(() => {
    const container = scrollRef.current
    if (!container) return
    const next = Math.min(
      MAX_ZOOM,
      Math.max(
        MIN_ZOOM,
        Math.min(container.clientWidth / BOARD_W, container.clientHeight / BOARD_H),
      ),
    )
    setZoom(+next.toFixed(2))
    container.scrollTo({ left: 0, top: 0 })
  }, [])

  // Ctrl+ホイールで拡大縮小。React の onWheel は passive なので preventDefault が効かず、
  // ブラウザのページ拡大が一緒に動いてしまう。自前で passive:false で貼る
  useEffect(() => {
    const container = scrollRef.current
    if (!container || listView) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      setZoom((z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, +(z - e.deltaY * 0.002).toFixed(2))))
    }
    container.addEventListener('wheel', onWheel, { passive: false })
    return () => container.removeEventListener('wheel', onWheel)
  }, [listView])

  /** 1 本目の指で始まっていた操作を取り消す（2 本指のパン / ピンチが始まったとき） */
  function cancelPointerOperations() {
    // 動かしかけの付箋を元の位置へ
    if (dragHoldsRef.current.size > 0) {
      for (const [id, origin] of dragOriginsRef.current) notes.patchLocal(id, origin)
      releaseDragHolds()
    }
    // 動かしかけのフレームと中の付箋も元へ
    const frameDrag = frameDragRef.current
    if (frameDrag) {
      frames.patchLocal(frameDrag.frame.id, { x: frameDrag.frame.x, y: frameDrag.frame.y })
      for (const [id, origin] of frameDrag.notes) notes.patchLocal(id, origin)
      frameDragRef.current = null
      releaseFrameHolds()
    }
    // 範囲選択と画面移動をやめる
    marqueeStartRef.current = null
    setMarquee(null)
    panRef.current = null
    setPanning(false)
    // 描きかけの線を捨てる
    setGestureNonce((n) => n + 1)
  }

  usePinchPan(scrollRef, {
    zoom,
    setZoom,
    min: MIN_ZOOM,
    max: MAX_ZOOM,
    enabled: !listView,
    onGestureStart: cancelPointerOperations,
  })

  // ---- キーボード ---------------------------------------------------------

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // モーダルが開いている間は、モーダル側に任せる（Delete で後ろの付箋が消えないように）
      if (hasOpenModal()) return
      // 右クリックメニューが開いている間も同じ。メニュー側がキーを受け取る
      if (menu) return

      if (e.code === 'Space' && !isTypingTarget(e.target)) {
        spaceRef.current = true
        return
      }
      if (isTypingTarget(e.target)) return

      // Shift + F10 とアプリケーションキー。macOS はこれで contextmenu を出さないので、
      // キー側からもメニューを開けるようにしておく
      if ((e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu') {
        e.preventDefault()
        openMenuFromKeyboard()
        return
      }

      const hit = matchShortcut(toChord(e))

      if (hit === 'help') {
        e.preventDefault()
        onOpenShortcuts()
        return
      }
      if (hit === 'escape') {
        clearSelection()
        return
      }
      if (hit === 'select-all') {
        e.preventDefault()
        selectAllNotes()
        return
      }
      if (hit === 'fit') {
        e.preventDefault()
        fitToScreen()
        return
      }
      if (canEdit && selectedNotes.length > 0) {
        if (hit === 'duplicate') {
          e.preventDefault()
          void duplicateNotes(selectedNotes)
          return
        }
        if (hit === 'wrap-frame') {
          e.preventDefault()
          void wrapSelectionInFrame(selectedNotes)
          return
        }
        if (hit === 'to-front' || hit === 'to-back') {
          e.preventDefault()
          void changeZ(selectedNotes, hit === 'to-front' ? 'front' : 'back')
          return
        }
      }

      if (e.ctrlKey || e.metaKey || e.altKey) return

      if ((e.key === 'Delete' || e.key === 'Backspace') && canEdit && selectedIds.length > 0) {
        e.preventDefault()
        void deleteSelection()
        return
      }

      const tool = HOTKEYS[e.key.toLowerCase()]
      if (tool && (canEdit || tool === 'select')) {
        e.preventDefault()
        setMode(tool)
      }
    }

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') spaceRef.current = false
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canEdit, selectedIds, selectedNotes, notes.rows, fitToScreen, onOpenShortcuts, menu])

  // ---- 共通 ---------------------------------------------------------------

  /**
   * Undo で作り直す行は、いま操作している人のものとして入れ直す。
   * RLS の INSERT 条件が author_id = auth.uid() なので、
   * 他の人が作ったものを消して取り消すと、そのままでは復活できない。
   */
  function asMine<T extends { author_id: string }>(row: T): T {
    return { ...row, author_id: userId }
  }

  function releaseDragHolds() {
    for (const release of dragHoldsRef.current.values()) release()
    dragHoldsRef.current = new Map()
  }

  function releaseFrameHolds() {
    for (const release of frameHoldsRef.current) release()
    frameHoldsRef.current = []
  }

  /*
   * タブを離れるときは、保留を必ず外す。
   *
   * 保留を持っているのは 1 つ上の useRealtimeTable で、タブの切り替えでは
   * 初期化されない。外し忘れると、そのボードを開いているあいだずっと
   * その付箋の x/y だけが他の人の更新も取り直しも受け付けなくなる。
   * しかも動かした位置は送っていないので、誰の画面でも古いまま止まる。
   *
   * 正常に終わる道（finishMove / cancelPointerOperations）では外しているが、
   * ドラッグの途中でタブを変えられると、そのどれも通らない。
   */
  useEffect(() => {
    return () => {
      releaseDragHolds()
      releaseFrameHolds()
    }
  }, [])

  // ---- 付箋 ---------------------------------------------------------------

  /** 付箋を足す。成功したら true */
  function insertNotes(rows: Note[]): Promise<boolean> {
    return noteOps.insert(rows, '付箋を保存')
  }

  /**
   * 付箋をゴミ箱に入れる。
   *
   * 本当に消してしまうと、他の人が消したものを戻す手段がない
   * （Ctrl+Z は自分の操作にしか効かない）。30 日は戻せるようにする。
   */
  function trashNotes(rows: Note[]): Promise<boolean> {
    const at = new Date().toISOString()
    setSelectedIds((current) => current.filter((id) => !rows.some((n) => n.id === id)))
    return noteOps.patchMany(rows, { deleted_at: at }, '削除を保存')
  }

  /** ゴミ箱から戻す */
  function restoreNotes(rows: Note[]): Promise<boolean> {
    return noteOps.patchMany(rows, { deleted_at: null }, '復元を保存')
  }

  /** 作った直後の取り消し用。ゴミ箱に残さず本当に消す。 */
  function deleteNotes(rows: Note[]): Promise<boolean> {
    setSelectedIds((current) => current.filter((id) => !rows.some((n) => n.id === id)))
    return noteOps.remove(rows, '削除')
  }

  /**
   * 付箋の一部を変える。
   * lock=true なら、本文・タグの変更に楽観ロックをかける（undo / redo から使う）。
   * updated_at は本文・タグが変わったときだけ進む（tg_touch_note_updated_at）ので、
   * 位置や色の変更にはかけない。
   */
  function applyNotePatch(id: string, patch: Partial<Note>, lock = false): Promise<PatchResult> {
    const touchesText = 'text' in patch || 'tags' in patch
    const current = notes.getRow(id)
    return noteOps.patch(id, patch, {
      what: '付箋を保存',
      expectUpdatedAt: lock && touchesText && current ? current.updated_at : undefined,
    })
  }

  /**
   * コピーした色をまとめて貼る。取り消しは 1 回にまとめる（整列と同じ）。
   * 元の色は付箋ごとに違うので、戻すときは 1 枚ずつの色を覚えておく。
   */
  async function applyStyleToNotes(rows: Note[], color: string) {
    const before = rows.map((note) => ({ id: note.id, color: note.color }))
    if (before.every((item) => item.color === color)) return

    const apply = async (list: { id: string; color: string }[]) => {
      const results = await Promise.all(
        list.map((item) => applyNotePatch(item.id, { color: item.color })),
      )
      return results.every((r) => r === 'ok')
    }
    const after = rows.map((note) => ({ id: note.id, color }))

    if (!(await apply(after))) return
    undoStack.push({
      label: rows.length > 1 ? `${rows.length} 件の色の貼り付け` : '色の貼り付け',
      undo: () => must(apply(before)),
      redo: () => must(apply(after)),
    })
  }

  function buildNote(x: number, y: number, kind: 'sticky' | 'text', text = ''): Note {
    const maxZ = notes.rows.reduce((max, n) => Math.max(max, n.z), 0)
    const now = new Date().toISOString()
    return {
      id: crypto.randomUUID(),
      room_id: roomId,
      kind,
      x: Math.max(0, x),
      y: Math.max(0, y),
      w: kind === 'text' ? 300 : 220,
      h: kind === 'text' ? 60 : 170,
      color: 'yellow',
      text,
      tags: [],
      z: maxZ + 1,
      // 0 = 種類ごとの既定。長押しで変えるまではこのまま
      font_size: 0,
      deleted_at: null,
      author_id: userId,
      author_name: displayName,
      created_at: now,
      updated_at: now,
    }
  }

  async function createNote(x: number, y: number, kind: 'sticky' | 'text') {
    const note = buildNote(x - (kind === 'text' ? 150 : 110), y - 40, kind)
    setSelectedIds([note.id])
    setMode('select')
    if (!(await insertNotes([note]))) return
    undoStack.push({
      label: kind === 'text' ? 'テキストの追加' : '付箋の追加',
      undo: () => must(deleteNotes([note])),
      redo: () => must(insertNotes([note])),
    })
  }

  /** 改行区切りのテキストから付箋をまとめて作る */
  async function createNotesFromText(text: string) {
    const lines = text
      .split('\n')
      .map((line) => line.replace(/^[-*・\s]+/, '').trim())
      .filter(Boolean)
      .slice(0, 60)

    if (lines.length === 0) return

    const [cx, cy] = visibleCenter()
    const perRow = Math.max(1, Math.min(6, Math.ceil(Math.sqrt(lines.length))))
    const startX = Math.max(20, cx - (perRow * 240) / 2)
    const startY = Math.max(20, cy - 200)

    const rows = lines.map((line, index) =>
      buildNote(
        startX + (index % perRow) * 240,
        startY + Math.floor(index / perRow) * 190,
        'sticky',
        line,
      ),
    )

    setShowBulk(false)
    if (!(await insertNotes(rows))) return
    undoStack.push({
      label: `${rows.length} 枚の付箋を作成`,
      undo: () => must(deleteNotes(rows)),
      redo: () => must(insertNotes(rows)),
    })
  }

  /**
   * 付箋の変更を保存する。
   *
   * 本文・タグを含む変更は楽観ロック付き。相手が先に変えていたら上書きせず、
   * 最新の内容に戻して知らせる。undo は保存できたときだけ積み、
   * 実行時には getRow で最新の updated_at を見る。
   */
  function commitNote(id: string, patch: Partial<Note>, label = '付箋の変更') {
    const current = notes.getRow(id)
    if (!current) return

    const before: Partial<Note> = {}
    for (const key of Object.keys(patch) as (keyof Note)[]) before[key] = current[key] as never
    const touchesText = 'text' in patch || 'tags' in patch

    void (async () => {
      const result = await noteOps.patch(id, patch, {
        what: '付箋を保存',
        expectUpdatedAt: touchesText ? current.updated_at : undefined,
      })
      // 'conflict' も 'error' も useOptimisticTable が知らせるので、ここでは積まないだけ
      if (result !== 'ok') return
      undoStack.push({
        label,
        undo: () => mustPatch(applyNotePatch(id, before, true)),
        redo: () => mustPatch(applyNotePatch(id, patch, true)),
      })
    })()
  }

  /** まとめて削除。1 枚でも複数でもここを通す */
  async function deleteNoteRows(rows: Note[]) {
    if (rows.length === 0) return
    const removed = rows.slice()
    if (!(await trashNotes(removed))) return
    undoStack.push({
      label: removed.length > 1 ? `${removed.length} 件の削除` : '付箋の削除',
      undo: () => must(restoreNotes(removed)),
      redo: () => must(trashNotes(removed)),
    })
  }

  function deleteNote(note: Note) {
    return deleteNoteRows([note])
  }

  function deleteSelection() {
    return deleteNoteRows(selectedNotes)
  }

  // ---- 付箋 → やること / 予定 ---------------------------------------------

  async function insertConverted(newTodos: Todo[], newEvents: CalendarEvent[]): Promise<boolean> {
    const [todosOk, eventsOk] = await Promise.all([
      todoOps.insert(newTodos, 'やることを保存'),
      eventOps.insert(newEvents, '予定を保存'),
    ])
    return todosOk && eventsOk
  }

  async function removeConverted(newTodos: Todo[], newEvents: CalendarEvent[]): Promise<boolean> {
    const [todosOk, eventsOk] = await Promise.all([
      todoOps.remove(newTodos, 'やることを削除'),
      eventOps.remove(newEvents, '予定を削除'),
    ])
    return todosOk && eventsOk
  }

  /** 変換ダイアログの入力を、実際の やること / 予定 にする */
  async function runConvert(plan: ConvertPlan) {
    const targets = converting?.notes ?? []
    if (targets.length === 0) return

    const author = { userId, displayName }
    const assignee = memberOptions.find((m) => m.id === plan.assigneeId)

    // 予定は「終日なら 0:00」、やることの期限は常に指定時刻で扱う
    const startIso = plan.date
      ? new Date(`${plan.date}T${plan.allDay ? '00:00' : plan.time}`).toISOString()
      : null
    const dueIso = plan.date ? new Date(`${plan.date}T${plan.time}`).toISOString() : null

    const newTodos: Todo[] = []
    const newEvents: CalendarEvent[] = []

    for (const note of targets) {
      const parsed = splitNoteText(note.text)
      const title = (targets.length === 1 ? plan.title : parsed.title).trim()
      if (!title) continue

      const body = targets.length === 1 ? plan.notes : parsed.body
      // 1 枚のときはダイアログで編集した結果をそのまま使う。
      // 複数枚のときは各付箋のタグに、ダイアログで足したタグを重ねる。
      const tags =
        targets.length === 1 ? plan.tags : [...new Set([...(note.tags ?? []), ...plan.tags])]

      if (plan.target === 'todo' || plan.target === 'both') {
        newTodos.push(
          buildTodo({
            roomId,
            author,
            title,
            notes: body,
            dueAt: dueIso,
            assigneeId: plan.assigneeId || null,
            assigneeName: assignee?.name ?? '',
            remindMinutes: plan.remind,
            tags,
            sourceNoteId: note.id,
            sourceSyncedAt: note.updated_at,
          }),
        )
      }

      if (plan.target !== 'todo' && startIso) {
        newEvents.push(
          buildEvent({
            roomId,
            author,
            // 「締切」で作ったものは、カレンダーの終日欄に控えめに出す
            kind: plan.target === 'deadline' ? 'deadline' : 'event',
            title,
            description: body,
            startAt: startIso,
            allDay: plan.allDay,
            remindMinutes: plan.remind,
            tags,
            sourceNoteId: note.id,
            sourceSyncedAt: note.updated_at,
          }),
        )
      }
    }

    setConverting(null)
    if (newTodos.length === 0 && newEvents.length === 0) return

    if (!(await insertConverted(newTodos, newEvents))) return
    undoStack.push({
      label: '付箋から作成',
      undo: () => must(removeConverted(newTodos, newEvents)),
      redo: () => must(insertConverted(newTodos, newEvents)),
    })

    const madeEvent = newEvents.length > 0

    // 付箋を書いた人に「行動になった」ことを知らせる
    const authors = new Map<string, string>()
    for (const note of targets) {
      if (note.author_id === userId) continue
      authors.set(note.author_id, splitNoteText(note.text).title || '付箋')
    }
    for (const [authorId, title] of authors) {
      await notifyUser({
        roomId,
        userId: authorId,
        kind: 'converted',
        body: `付箋「${title}」が${madeEvent ? '予定' : 'やること'}になりました`,
        linkTab: madeEvent ? 'calendar' : 'todo',
        linkId: madeEvent ? newEvents[0].id : newTodos[0].id,
      })
    }

    setCreated({
      text: madeEvent
        ? `📅 予定を ${newEvents.length} 件${newTodos.length > 0 ? `、⏰ やることを ${newTodos.length} 件` : ''}作りました`
        : `⏰ やることを ${newTodos.length} 件作りました`,
      tab: madeEvent ? 'calendar' : 'todo',
      id: madeEvent ? newEvents[0].id : newTodos[0].id,
    })
  }

  /** 一覧表示から付箋を足す。空いている場所を探さず、末尾のグリッドへ置く */
  async function createNoteInList() {
    const note = buildNote(0, 0, 'sticky')
    const placed = { ...note, ...gridPosition(notes.rows.length) }
    if (!(await insertNotes([placed]))) return
    undoStack.push({
      label: '付箋の追加',
      undo: () => must(deleteNotes([placed])),
      redo: () => must(insertNotes([placed])),
    })
  }

  /**
   * 一覧で隣り合う 2 枚を入れ替える。
   *
   * 一覧と board は同じ付箋を見ているので、並び替えは座標へ書き戻さないと
   * パソコンで開いたときに順番が合わなくなる。全部の座標を作り直すのではなく、
   * 2 枚の位置を交換するだけにして、他の人が置いた場所を崩さない。
   */
  async function swapNotes(a: Note, b: Note) {
    const from = [
      { id: a.id, x: a.x, y: a.y },
      { id: b.id, x: b.x, y: b.y },
    ]
    const to = [
      { id: a.id, x: b.x, y: b.y },
      { id: b.id, x: a.x, y: a.y },
    ]
    const apply = async (list: { id: string; x: number; y: number }[]) => {
      const results = await Promise.all(
        list.map((item) =>
          noteOps.patch(item.id, { x: item.x, y: item.y }, { what: '並べ替えを保存' }),
        ),
      )
      return results.every((r) => r === 'ok')
    }

    if (!(await apply(to))) return
    undoStack.push({ label: '並べ替え', undo: () => must(apply(from)), redo: () => must(apply(to)) })
  }

  /** 付箋から生まれた やること / 予定 を、そのタブで開く */
  function openLink(note: Note, target: 'todo' | 'event') {
    if (target === 'todo') {
      const todo = todos.rows.find((t) => t.source_note_id === note.id)
      if (todo) onJump('todo', todo.id)
      return
    }
    const event = events.rows.find((e) => e.source_note_id === note.id)
    if (event) onJump('calendar', event.id)
  }

  function selectNote(id: string, additive: boolean) {
    // つなぐモードでは、1 枚目→2 枚目の順に選んで線を作る
    if (mode === 'connect') {
      if (!connectFrom) {
        setConnectFrom(id)
      } else if (connectFrom !== id) {
        void createConnector(connectFrom, id)
        setConnectFrom(null)
      }
      return
    }

    const next = additive
      ? selectedIds.includes(id)
        ? selectedIds.filter((x) => x !== id)
        : [...selectedIds, id]
      : selectedIds.includes(id)
        ? selectedIds
        : [id]

    setSelectedIds(next)
    setSelectedOther(null)

    const origins = new Map<string, { x: number; y: number }>()
    for (const noteId of next) {
      const note = notes.getRow(noteId)
      if (note) origins.set(noteId, { x: note.x, y: note.y })
    }
    dragOriginsRef.current = origins
    releaseDragHolds()

    // 最前面へ。すでに最前面（同率がいない）なら書かない（クリックのたびに UPDATE を送らない）
    if (canEdit && !additive && next.length === 1) {
      const note = notes.getRow(id)
      const maxZ = notes.rows.reduce((max, n) => Math.max(max, n.z), 0)
      const topCount = notes.rows.filter((n) => n.z === maxZ).length
      if (note && (note.z < maxZ || topCount > 1)) void applyNotePatch(id, { z: maxZ + 1 })
    }
  }

  function moveSelection({ dx, dy }: { dx: number; dy: number }) {
    for (const [id, origin] of dragOriginsRef.current) {
      const note = notes.getRow(id)
      if (!note) continue

      // ドラッグ中は他の人のエコーで位置が飛ばないように x/y を保留する
      if (!dragHoldsRef.current.has(id)) {
        dragHoldsRef.current.set(id, notes.holdLocal(id, ['x', 'y']))
      }

      // 吸着はここではかけない（finishMove で指を離したときに 1 回だけ）。
      // 動かしている最中に 20px 刻みにすると、付箋がカクカク跳ぶように見えるため。
      const x = Math.max(0, origin.x + dx)
      const y = Math.max(0, origin.y + dy)
      if (note.x !== x || note.y !== y) notes.patchLocal(id, { x, y })
    }
  }

  /** グリッドに吸着させる（指を離したときに 1 回だけ） */
  function snapDraggedNotes() {
    if (!snap) return
    for (const [id] of dragOriginsRef.current) {
      const note = notes.getRow(id)
      if (!note) continue
      const x = snapToGrid(note.x, GRID)
      const y = snapToGrid(note.y, GRID)
      if (note.x !== x || note.y !== y) notes.patchLocal(id, { x, y })
    }
  }

  async function finishMove() {
    snapDraggedNotes()

    const origins = dragOriginsRef.current
    const moved = [...origins.entries()]
      .map(([id, origin]) => {
        const note = notes.getRow(id)
        if (!note || (note.x === origin.x && note.y === origin.y)) return null
        return { id, from: origin, to: { x: note.x, y: note.y } }
      })
      .filter((v): v is NonNullable<typeof v> => v !== null)

    if (moved.length === 0) {
      releaseDragHolds()
      return
    }

    const apply = async (which: 'from' | 'to') => {
      const results = await Promise.all(
        moved.map((m) => noteOps.patch(m.id, m[which], { what: '移動を保存' })),
      )
      return results.every((r) => r === 'ok')
    }

    let ok = false
    try {
      ok = await apply('to')
    } finally {
      // 保存が返ってきてから保留を外す（返る前に外すと、古いエコーで位置が戻ることがある）
      releaseDragHolds()
    }
    if (!ok) return

    // 次のドラッグの基準は動かしたあとの位置
    for (const m of moved) origins.set(m.id, m.to)
    undoStack.push({
      label: moved.length > 1 ? `${moved.length} 件の移動` : '付箋の移動',
      undo: () => must(apply('from')),
      redo: () => must(apply('to')),
    })
  }

  async function align(kind: AlignKind) {
    // 並べ直したあとの位置の計算は lib/boardAlign.ts。ここは保存と Undo だけ
    const after = alignNotes(selectedNotes, kind, GRID)
    if (after.length === 0) return
    const before = selectedNotes.map((n) => ({ id: n.id, x: n.x, y: n.y }))

    const apply = async (list: { id: string; x: number; y: number }[]) => {
      const results = await Promise.all(
        list.map((item) =>
          noteOps.patch(item.id, { x: item.x, y: item.y }, { what: '整列を保存' }),
        ),
      )
      return results.every((r) => r === 'ok')
    }

    if (!(await apply(after))) return
    // 次のドラッグの基準を揃えたあとの位置にする
    for (const item of after) dragOriginsRef.current.set(item.id, { x: item.x, y: item.y })
    undoStack.push({ label: '整列', undo: () => must(apply(before)), redo: () => must(apply(after)) })
  }

  // ---- 重なり順・複製 -----------------------------------------------------

  /**
   * 付箋の重なり順を変える。
   *
   * z に CHECK 制約は無いので、最背面は負の値でよい。全部を振り直すと共同編集で
   * 大量の UPDATE が飛ぶため、端に足すだけにしてある（既存の「クリックで最前面」と同じ流儀）。
   * 負になっても付箋レイヤー（z-10）の中で閉じるので、画像レイヤーより下には潜らない。
   */
  async function changeZ(rows: Note[], where: 'front' | 'back') {
    if (rows.length === 0) return

    const before = rows.map((n) => ({ id: n.id, z: n.z }))
    const edge =
      where === 'front'
        ? notes.rows.reduce((max, n) => Math.max(max, n.z), 0)
        : notes.rows.reduce((min, n) => Math.min(min, n.z), 0)

    // 選んだものどうしの相対順序は保ったまま動かす
    const ordered = rows.slice().sort((a, b) => a.z - b.z)
    const after = ordered.map((n, i) => ({
      id: n.id,
      z: where === 'front' ? edge + 1 + i : edge - ordered.length + i,
    }))

    const apply = async (list: { id: string; z: number }[]) => {
      const results = await Promise.all(
        list.map((item) => noteOps.patch(item.id, { z: item.z }, { what: '重なり順を保存' })),
      )
      return results.every((r) => r === 'ok')
    }

    if (!(await apply(after))) return
    undoStack.push({
      label: '重なり順の変更',
      undo: () => must(apply(before)),
      redo: () => must(apply(after)),
    })
  }

  /** 付箋を少しずらして複製する */
  async function duplicateNotes(rows: Note[]) {
    if (rows.length === 0) return

    const maxZ = notes.rows.reduce((max, n) => Math.max(max, n.z), 0)
    const now = new Date().toISOString()
    // RLS の INSERT 条件が author_id = auth.uid() なので、他の人の付箋を複製するときも
    // 自分のものとして入れ直す。元の author_id のままだと 1 件も入らない
    const copies: Note[] = rows.map((note, i) => ({
      ...note,
      id: crypto.randomUUID(),
      x: Math.min(BOARD_W - note.w, note.x + 20),
      y: Math.min(BOARD_H - note.h, note.y + 20),
      z: maxZ + 1 + i,
      deleted_at: null,
      author_id: userId,
      author_name: displayName,
      created_at: now,
      updated_at: now,
    }))

    setSelectedIds(copies.map((n) => n.id))
    if (!(await insertNotes(copies))) return
    undoStack.push({
      label: '複製',
      undo: () => must(deleteNotes(copies)),
      redo: () => must(insertNotes(copies)),
    })
  }

  // ---- コピー・貼り付け ---------------------------------------------------

  /** メニューからのコピー。システム側へも本文を渡しておく */
  function copyNotes(rows: Note[]) {
    if (rows.length === 0) return
    setClipboardNotes(rows)
    // http（VITE_LAN=1）や古いブラウザには navigator.clipboard が無い。
    // ここは「他のアプリにも貼れたら嬉しい」程度のおまけなので、失敗は黙って捨てる
    void navigator.clipboard?.writeText(notesToText(rows)).catch(() => {})
    setNotice(`${rows.length} 件の付箋をコピーしました`)
  }

  async function pasteNotes(x: number, y: number) {
    const source = getClipboardNotes()
    if (source.length === 0) return

    const rows = buildPastedNotes(source, {
      roomId,
      userId,
      displayName,
      x,
      y,
      baseZ: notes.rows.reduce((max, n) => Math.max(max, n.z), 0),
      boardW: BOARD_W,
      boardH: BOARD_H,
    })
    if (rows.length === 0) return

    setSelectedIds(rows.map((n) => n.id))
    if (!(await insertNotes(rows))) return
    undoStack.push({
      label: '貼り付け',
      undo: () => must(deleteNotes(rows)),
      redo: () => must(insertNotes(rows)),
    })
  }

  /** 選んだ付箋をまとめて囲むフレームを作る（Figma の "Wrap selection in frame"） */
  async function wrapSelectionInFrame(rows: Note[]) {
    if (rows.length === 0) return

    // 上だけ広く空けるのは、フレームの名前バーが枠の外（-top-7）に出るぶん
    const box = boundingBox(rows, { top: 72, right: 40, bottom: 40, left: 40 })
    if (!box) return

    const maxZ = frames.rows.reduce((max, f) => Math.max(max, f.z), 0)
    const frame: Frame = {
      id: crypto.randomUUID(),
      room_id: roomId,
      ...box,
      title: '',
      color: 'slate',
      z: maxZ + 1,
      deleted_at: null,
      author_id: userId,
      author_name: displayName,
      created_at: new Date().toISOString(),
    }

    if (!(await frameOps.insert([frame], 'フレームを保存'))) return
    undoStack.push({
      label: 'フレームで囲む',
      undo: () => must(deleteFrame(frame, false)),
      redo: () => must(restoreFrame(frame)),
    })
  }

  // ---- コネクタ -----------------------------------------------------------

  async function createConnector(fromId: string, toId: string) {
    const exists = connectors.rows.some(
      (c) =>
        (c.from_note_id === fromId && c.to_note_id === toId) ||
        (c.from_note_id === toId && c.to_note_id === fromId),
    )
    if (exists) {
      setNotice('この 2 枚はすでにつながっています。')
      return
    }

    const connector: Connector = {
      id: crypto.randomUUID(),
      room_id: roomId,
      from_note_id: fromId,
      to_note_id: toId,
      style: 'arrow',
      color: '#64748b',
      label: '',
      deleted_at: null,
      author_id: userId,
      created_at: new Date().toISOString(),
    }

    if (!(await connectorOps.insert([connector], '線を保存'))) return
    undoStack.push({
      label: '線でつなぐ',
      undo: () => must(deleteConnector(connector, false)),
      redo: () => must(restoreConnector(connector)),
    })
  }

  /*
   * 線・フレーム・ファイルの削除はゴミ箱行き（deleted_at を入れるだけ）。
   *
   * 消えるのは画面上だけなので、他の人が消したものも 30 日は戻せる。
   * 行が残るぶん、復元は再 INSERT ではなく UPDATE になり、
   * author_id を自分に付け替える asMine() も要らなくなった。
   */
  async function trashConnector(connector: Connector, restore = false): Promise<boolean> {
    const at = restore ? null : new Date().toISOString()
    if (!restore) setSelectedOther(null)
    const result = await connectorOps.patch(
      connector.id,
      { deleted_at: at },
      { what: restore ? '復元を保存' : '線の削除を保存' },
    )
    return result === 'ok'
  }

  async function deleteConnector(connector: Connector, pushHistory = true): Promise<boolean> {
    if (!(await trashConnector(connector))) return false

    if (pushHistory) {
      undoStack.push({
        label: '線の削除',
        undo: () => must(restoreConnector(connector)),
        redo: () => must(deleteConnector(connector, false)),
      })
    }
    return true
  }

  function restoreConnector(connector: Connector): Promise<boolean> {
    return trashConnector(connector, true)
  }

  function patchConnector(id: string, patch: Partial<Connector>): Promise<PatchResult> {
    return connectorOps.patch(id, patch, { what: '線の変更を保存' })
  }

  function commitConnector(id: string, patch: Partial<Connector>, label: string) {
    const current = connectors.getRow(id)
    if (!current) return
    const before: Partial<Connector> = {}
    for (const key of Object.keys(patch) as (keyof Connector)[])
      before[key] = current[key] as never

    void (async () => {
      if ((await patchConnector(id, patch)) !== 'ok') return
      undoStack.push({
        label,
        undo: () => mustPatch(patchConnector(id, before)),
        redo: () => mustPatch(patchConnector(id, patch)),
      })
    })()
  }

  // ---- フレーム -----------------------------------------------------------

  async function createFrame(x: number, y: number) {
    const maxZ = frames.rows.reduce((max, f) => Math.max(max, f.z), 0)
    const frame: Frame = {
      id: crypto.randomUUID(),
      room_id: roomId,
      x: Math.max(0, x - 300),
      y: Math.max(0, y - 200),
      w: 600,
      h: 400,
      title: '',
      color: 'slate',
      z: maxZ + 1,
      deleted_at: null,
      author_id: userId,
      author_name: displayName,
      created_at: new Date().toISOString(),
    }

    setMode('select')
    setSelectedOther({ kind: 'frame', id: frame.id })

    if (!(await frameOps.insert([frame], 'フレームを保存'))) {
      setSelectedOther(null)
      return
    }
    undoStack.push({
      label: 'フレームの追加',
      undo: () => must(deleteFrame(frame, false)),
      redo: () => must(restoreFrame(frame)),
    })
  }

  async function trashFrame(frame: Frame, restore = false): Promise<boolean> {
    const at = restore ? null : new Date().toISOString()
    if (!restore) setSelectedOther(null)
    const result = await frameOps.patch(
      frame.id,
      { deleted_at: at },
      { what: restore ? '復元を保存' : 'フレームの削除を保存' },
    )
    return result === 'ok'
  }

  async function deleteFrame(frame: Frame, pushHistory = true): Promise<boolean> {
    if (!(await trashFrame(frame))) return false

    if (pushHistory) {
      undoStack.push({
        label: 'フレームの削除',
        undo: () => must(restoreFrame(frame)),
        redo: () => must(deleteFrame(frame, false)),
      })
    }
    return true
  }

  function restoreFrame(frame: Frame): Promise<boolean> {
    return trashFrame(frame, true)
  }

  function applyFramePatch(id: string, patch: Partial<Frame>): Promise<PatchResult> {
    return frameOps.patch(id, patch, { what: 'フレームの変更を保存' })
  }

  function commitFrame(id: string, patch: Partial<Frame>) {
    const current = frames.getRow(id)
    if (!current) return
    const before: Partial<Frame> = {}
    for (const key of Object.keys(patch) as (keyof Frame)[]) before[key] = current[key] as never

    void (async () => {
      if ((await applyFramePatch(id, patch)) !== 'ok') return
      undoStack.push({
        label: 'フレームの変更',
        undo: () => mustPatch(applyFramePatch(id, before)),
        redo: () => mustPatch(applyFramePatch(id, patch)),
      })
    })()
  }

  /** フレームを掴むと、中に入っている付箋も一緒に動く */
  function moveFrame(frame: Frame, dx: number, dy: number) {
    if (!frameDragRef.current || frameDragRef.current.frame.id !== frame.id) {
      releaseFrameHolds()
      const inside = new Map(
        insideRect(notes.rows, frame).map((note) => [note.id, { x: note.x, y: note.y }]),
      )
      frameDragRef.current = { frame: { ...frame }, notes: inside }
      // ドラッグ中は他の人のエコーで位置が飛ばないように保留する
      frameHoldsRef.current = [
        frames.holdLocal(frame.id, ['x', 'y']),
        ...[...inside.keys()].map((id) => notes.holdLocal(id, ['x', 'y'])),
      ]
    }

    const origin = frameDragRef.current.frame
    frames.patchLocal(frame.id, { x: Math.max(0, origin.x + dx), y: Math.max(0, origin.y + dy) })

    for (const [id, start] of frameDragRef.current.notes) {
      if (notes.getRow(id)) {
        notes.patchLocal(id, { x: Math.max(0, start.x + dx), y: Math.max(0, start.y + dy) })
      }
    }
  }

  async function finishFrameMove() {
    const drag = frameDragRef.current
    frameDragRef.current = null
    if (!drag) {
      releaseFrameHolds()
      return
    }

    const frame = frames.getRow(drag.frame.id)
    if (!frame || (frame.x === drag.frame.x && frame.y === drag.frame.y)) {
      releaseFrameHolds()
      return
    }

    try {
      await Promise.all([
        frameOps.patch(frame.id, { x: frame.x, y: frame.y }, { what: 'フレームの移動を保存' }),
        ...[...drag.notes.keys()].map((id) => {
          const note = notes.getRow(id)
          return note
            ? noteOps.patch(id, { x: note.x, y: note.y }, { what: '移動を保存' })
            : Promise.resolve<PatchResult>('ok')
        }),
      ])
    } finally {
      releaseFrameHolds()
    }
  }

  // ---- リアクション -------------------------------------------------------

  async function toggleReaction(note: Note, emoji: string) {
    const existing = reactions.rows.find(
      (r) => r.note_id === note.id && r.user_id === userId && r.emoji === emoji,
    )
    if (existing) {
      await reactionOps.remove([existing], 'リアクションを保存')
      return
    }

    const reaction: NoteReaction = {
      id: crypto.randomUUID(),
      room_id: roomId,
      note_id: note.id,
      user_id: userId,
      emoji,
      created_at: new Date().toISOString(),
    }
    await reactionOps.insert([reaction], 'リアクションを保存')
  }

  async function toggleVote(note: Note) {
    const existing = votes.rows.find((v) => v.note_id === note.id && v.user_id === userId)
    if (existing) {
      await voteOps.remove([existing], '投票を保存')
      return
    }

    const vote: NoteVote = {
      id: crypto.randomUUID(),
      room_id: roomId,
      note_id: note.id,
      user_id: userId,
      voter_name: displayName,
      created_at: new Date().toISOString(),
    }
    await voteOps.insert([vote], '投票を保存')
  }

  // ---- 手描き・図形 -------------------------------------------------------

  function insertStroke(stroke: Stroke): Promise<boolean> {
    return strokeOps.insert([asMine(stroke)], '線を保存')
  }

  /**
   * 行ごと消す。使うのは「描いたことを取り消す」ときだけ。
   *
   * 描いてすぐ Ctrl+Z を押したぶんまでゴミ箱に残ると、一覧が
   * 「描かなかったことにしたもの」で埋まる。消しゴムとは別扱いにしている。
   */
  function deleteStrokeRow(stroke: Stroke): Promise<boolean> {
    return strokeOps.remove([stroke], '線の削除を保存')
  }

  /**
   * ゴミ箱へ入れる／戻す。消しゴムと全消しはこちら。
   *
   * 手描きだけ、live がゴミ箱の行をはじめから持たない（roomData の skipDeleted。
   * points が重いので、消した線まで全員に配らない）。それでも画面から消えるのは
   * useWithoutDeleted が deleted_at の入った行を rows から外すため。
   * 戻すときは行が手元に無いこともあるが、patch は返ってきた行を入れ直すので届く。
   */
  async function trashStroke(stroke: Stroke, restore = false): Promise<boolean> {
    const result = await strokeOps.patch(
      stroke.id,
      { deleted_at: restore ? null : new Date().toISOString() },
      { what: restore ? '復元を保存' : '線の削除を保存' },
    )
    return result === 'ok'
  }

  async function commitStroke(kind: StrokeKind, points: Point[], color: string, width: number) {
    const stroke: Stroke = {
      id: crypto.randomUUID(),
      room_id: roomId,
      kind,
      points,
      color,
      width,
      author_id: userId,
      created_at: new Date().toISOString(),
      deleted_at: null,
    }
    if (!(await insertStroke(stroke))) return
    undoStack.push({
      label: kind === 'free' ? '線を描く' : '図形を描く',
      undo: () => must(deleteStrokeRow(stroke)),
      redo: () => must(insertStroke(stroke)),
    })
  }

  async function eraseStroke(id: string) {
    const stroke = strokes.getRow(id)
    if (!stroke) return
    if (!(await trashStroke(stroke))) return
    undoStack.push({
      label: '線を消す',
      undo: () => must(trashStroke(stroke, true)),
      redo: () => must(trashStroke(stroke)),
    })
  }

  function strokesInScope(scope: 'mine' | 'all'): Stroke[] {
    return scope === 'mine'
      ? strokes.rows.filter((s) => s.author_id === userId)
      : strokes.rows.slice()
  }

  /**
   * 全消し本体。ゴミ箱へ入れた印として、同じ at を全部の行に書く。
   *
   * 消すのは id の列挙ではなく room_id（＋author_id）の条件更新にして、
   * こちらがまだ受け取っていない線も一緒にゴミ箱へ入れる。
   * すでにゴミ箱にある行は塗り替えない——塗ると、前に消した線が
   * この全消しの取り消しでまとめて戻ってきてしまう。
   */
  async function clearStrokesAt(scope: 'mine' | 'all', at: string): Promise<boolean> {
    const removed = strokesInScope(scope)
    const releases = removed.map((s) => strokes.holdLocal(s.id, 'delete'))
    for (const s of removed) strokes.removeLocal(s.id)
    try {
      let query = supabase
        .from('strokes')
        .update({ deleted_at: at })
        .eq('room_id', roomId)
        .is('deleted_at', null)
      if (scope === 'mine') query = query.eq('author_id', userId)
      const { error } = await query
      if (error) throw error
      return true
    } catch (e) {
      for (const s of removed) strokes.upsertLocal(s)
      setNotice(`線を消せませんでした: ${messageOf(e)}`)
      return false
    } finally {
      for (const release of releases) release()
    }
  }

  /**
   * 全消しの取り消し。
   *
   * id を並べずに「あのとき消した線」を指せるのは、1 回の全消しが同じ
   * deleted_at を書いているため。2500 本ぶんの id を URL に並べると
   * PostgREST の in() が長さで壊れるので、この指し方にしている。
   */
  async function restoreClearedStrokes(at: string): Promise<boolean> {
    try {
      const { data, error } = await supabase
        .from('strokes')
        .update({ deleted_at: null })
        .eq('room_id', roomId)
        .eq('deleted_at', at)
        .select('*')
      if (error) throw error
      for (const row of (data ?? []) as Stroke[]) strokes.upsertLocal(row)
      return true
    } catch (e) {
      setNotice(`線を戻せませんでした: ${messageOf(e)}`)
      return false
    }
  }

  /** 線をまとめて消す。自分の線だけか、全員の線か */
  async function clearStrokes(scope: 'mine' | 'all') {
    setShowClearStrokes(false)
    if (strokesInScope(scope).length === 0) return

    const at = new Date().toISOString()
    if (!(await clearStrokesAt(scope, at))) return

    undoStack.push({
      label: scope === 'mine' ? '自分の線の全消去' : '線の全消去',
      undo: () => must(restoreClearedStrokes(at)),
      redo: () => must(clearStrokesAt(scope, at)),
    })
  }

  // ---- 画像・ファイル -----------------------------------------------------

  function insertImage(image: BoardImage): Promise<boolean> {
    return imageOps.insert([asMine(image)], '画像を保存')
  }

  function deleteImageRow(image: BoardImage): Promise<boolean> {
    setSelectedOther(null)
    return imageOps.remove([image], '画像の削除を保存')
  }

  function applyImagePatch(id: string, patch: Partial<BoardImage>): Promise<PatchResult> {
    return imageOps.patch(id, patch, { what: '画像の変更を保存' })
  }

  function commitImage(id: string, patch: Partial<BoardImage>) {
    const current = images.getRow(id)
    if (!current) return
    const before: Partial<BoardImage> = {}
    for (const key of Object.keys(patch) as (keyof BoardImage)[])
      before[key] = current[key] as never

    void (async () => {
      if ((await applyImagePatch(id, patch)) !== 'ok') return
      undoStack.push({
        label: '画像の移動',
        undo: () => mustPatch(applyImagePatch(id, before)),
        redo: () => mustPatch(applyImagePatch(id, patch)),
      })
    })()
  }

  /** 画像をゴミ箱に入れる（Storage の実体はそのまま残す） */
  async function trashImage(image: BoardImage, restore = false): Promise<boolean> {
    const at = restore ? null : new Date().toISOString()
    if (!restore) setSelectedOther(null)
    const result = await imageOps.patch(
      image.id,
      { deleted_at: at },
      { what: restore ? '復元を保存' : '削除を保存' },
    )
    return result === 'ok'
  }

  async function deleteImage(image: BoardImage) {
    if (!(await trashImage(image))) return
    undoStack.push({
      label: '画像の削除',
      undo: () => must(trashImage(image, true)),
      redo: () => must(trashImage(image)),
    })
  }

  async function uploadImage(file: File, x: number, y: number) {
    if (!canEdit) return

    /*
     * オフラインのあいだは、はっきり断る。
     *
     * 送信箱にためられるのは文字だけで、画像とファイルは入れていない
     * （実体の置き場と行の作成が一度に決まらないため。README の「制約」を参照）。
     * 黙って進めると、進む気配のスピナーだけが残って嘘になる。
     */
    if (!navigator.onLine) {
      setNotice('オフラインのあいだは画像を貼れません。つながってからもう一度どうぞ。')
      return
    }

    if (file.size > MAX_IMAGE_ACCEPT_BYTES) {
      setNotice('画像は 20MB までです。')
      return
    }

    setBusy('画像を整えています…')
    try {
      let prepared
      try {
        prepared = await prepareImageForUpload(file, { maxEdge: 1600, quality: 0.85 })
      } catch (e) {
        setNotice(`画像を読み込めませんでした: ${messageOf(e)}`)
        return
      }
      if (prepared.blob.size > MAX_IMAGE_UPLOAD_BYTES) {
        setNotice('縮小しても 5MB を超える画像は貼れません。')
        return
      }

      setBusy('画像を送信中…')
      const path = `${roomId}/${crypto.randomUUID()}.${prepared.ext}`
      const { error } = await supabase.storage
        .from(IMAGE_BUCKET)
        .upload(path, prepared.blob, { contentType: prepared.contentType })
      if (error) {
        setNotice(`画像をアップロードできませんでした: ${error.message}`)
        return
      }

      // ボード上の表示サイズ。横幅 480 までに収める
      const w = Math.min(480, prepared.width || 480)
      const ratio = prepared.width && prepared.height ? prepared.height / prepared.width : 0.75
      const h = Math.round(w * ratio)
      const maxZ = images.rows.reduce((max, i) => Math.max(max, i.z), 0)
      const image: BoardImage = {
        id: crypto.randomUUID(),
        room_id: roomId,
        storage_path: path,
        x: Math.max(0, x - w / 2),
        y: Math.max(0, y - h / 2),
        w,
        h,
        z: maxZ + 1,
        deleted_at: null,
        author_id: userId,
        author_name: displayName,
        created_at: new Date().toISOString(),
      }

      if (!(await insertImage(image))) return
      setMode('select')
      setSelectedOther({ kind: 'image', id: image.id })
      undoStack.push({
        label: '画像の貼り付け',
        undo: () => must(deleteImageRow(image)),
        redo: () => must(insertImage(image)),
      })
    } finally {
      setBusy(null)
    }
  }

  async function uploadFile(file: File, x: number, y: number) {
    if (!canEdit) return

    /*
     * オフラインのあいだは、はっきり断る。
     *
     * 送信箱にためられるのは文字だけで、画像とファイルは入れていない
     * （実体の置き場と行の作成が一度に決まらないため。README の「制約」を参照）。
     * 黙って進めると、進む気配のスピナーだけが残って嘘になる。
     */
    if (!navigator.onLine) {
      setNotice('オフラインのあいだはファイルを置けません。つながってからもう一度どうぞ。')
      return
    }

    if (file.type.startsWith('image/')) {
      await uploadImage(file, x, y)
      return
    }
    if (file.size > MAX_FILE_BYTES) {
      setNotice('ファイルは 10MB までです。')
      return
    }

    setBusy('ファイルを送信中…')
    try {
      // 拡張子はファイル名から取るので、英数字だけに削ってから使う（画像側と同じ扱い）。
      // '/' が入るとフォルダが増え、パスの先頭フォルダで判定している権限の前提が崩れる。
      const ext =
        (file.name.split('.').pop() ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10) ||
        'bin'
      const path = `${roomId}/${crypto.randomUUID()}.${ext}`
      const { error } = await supabase.storage
        .from(FILE_BUCKET)
        .upload(path, file, { contentType: file.type || 'application/octet-stream' })
      if (error) {
        // バケット側で種類を絞っている（HTML や SVG は置けない）。
        // 素の英語メッセージだと何が悪いのか伝わらないので読み替える。
        setNotice(
          /mime|content.?type/i.test(error.message)
            ? 'この種類のファイルは置けません（PDF・画像・テキスト・Office 文書・zip に対応しています）。'
            : `アップロードできませんでした: ${error.message}`,
        )
        return
      }

      const maxZ = attachments.rows.reduce((max, a) => Math.max(max, a.z), 0)
      const attachment: Attachment = {
        id: crypto.randomUUID(),
        room_id: roomId,
        storage_path: path,
        filename: file.name,
        mime: file.type,
        size: file.size,
        x: Math.max(0, x - 100),
        y: Math.max(0, y - 40),
        z: maxZ + 1,
        deleted_at: null,
        author_id: userId,
        author_name: displayName,
        created_at: new Date().toISOString(),
      }

      if (!(await attachmentOps.insert([attachment], 'ファイルを保存'))) return

      setMode('select')
      setSelectedOther({ kind: 'attachment', id: attachment.id })
      undoStack.push({
        label: 'ファイルの追加',
        undo: () => must(deleteAttachment(attachment, false)),
        redo: () => must(restoreAttachment(attachment)),
      })
    } finally {
      setBusy(null)
    }
  }

  async function trashAttachment(attachment: Attachment, restore = false): Promise<boolean> {
    const at = restore ? null : new Date().toISOString()
    if (!restore) setSelectedOther(null)
    const result = await attachmentOps.patch(
      attachment.id,
      { deleted_at: at },
      { what: restore ? '復元を保存' : 'ファイルの削除を保存' },
    )
    return result === 'ok'
  }

  async function deleteAttachment(attachment: Attachment, pushHistory = true): Promise<boolean> {
    if (!(await trashAttachment(attachment))) return false

    if (pushHistory) {
      undoStack.push({
        label: 'ファイルの削除',
        undo: () => must(restoreAttachment(attachment)),
        redo: () => must(deleteAttachment(attachment, false)),
      })
    }
    return true
  }

  function restoreAttachment(attachment: Attachment): Promise<boolean> {
    return trashAttachment(attachment, true)
  }

  function applyAttachmentPatch(id: string, patch: Partial<Attachment>): Promise<PatchResult> {
    return attachmentOps.patch(id, patch, { what: 'ファイルの変更を保存' })
  }

  function commitAttachment(id: string, patch: Partial<Attachment>) {
    const current = attachments.getRow(id)
    if (!current) return
    const before: Partial<Attachment> = {}
    for (const key of Object.keys(patch) as (keyof Attachment)[])
      before[key] = current[key] as never

    void (async () => {
      if ((await applyAttachmentPatch(id, patch)) !== 'ok') return
      undoStack.push({
        label: 'ファイルの移動',
        undo: () => mustPatch(applyAttachmentPatch(id, before)),
        redo: () => mustPatch(applyAttachmentPatch(id, patch)),
      })
    })()
  }

  function visibleCenter(): Point {
    const container = scrollRef.current
    if (!container) return [BOARD_W / 2, BOARD_H / 2]
    return [
      (container.scrollLeft + container.clientWidth / 2) / zoom,
      (container.scrollTop + container.clientHeight / 2) / zoom,
    ]
  }

  /**
   * コピー・切り取り・貼り付け。
   *
   * Ctrl+C / Ctrl+X / Ctrl+V は keydown で拾わない。拾うとブラウザが出す
   * copy / cut / paste イベントと二重に走ってしまう。イベント側だけを使う。
   * この書き方なら権限のダイアログも要らず、http（VITE_LAN=1）でも動く。
   */
  useEffect(() => {
    const inForm = (target: EventTarget | null) => {
      const el = target as HTMLElement | null
      return el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA' || el?.isContentEditable
    }

    const onCopy = (e: ClipboardEvent) => {
      if (hasOpenModal() || inForm(e.target) || selectedNotes.length === 0) return
      e.preventDefault()
      setClipboardNotes(selectedNotes)
      // 他のアプリへ渡せるのは本文だけ。色や大きさはこのアプリの中でだけ保つ
      e.clipboardData?.setData('text/plain', notesToText(selectedNotes))
      setNotice(`${selectedNotes.length} 件の付箋をコピーしました`)
    }

    const onCut = (e: ClipboardEvent) => {
      if (!canEdit || hasOpenModal() || inForm(e.target) || selectedNotes.length === 0) return
      e.preventDefault()
      setClipboardNotes(selectedNotes)
      e.clipboardData?.setData('text/plain', notesToText(selectedNotes))
      void deleteSelection()
    }

    const onPaste = (e: ClipboardEvent) => {
      if (!canEdit || hasOpenModal() || inForm(e.target)) return

      // 画像ファイルが最優先（従来どおり）
      const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'))
      if (file) {
        e.preventDefault()
        const [x, y] = visibleCenter()
        void uploadImage(file, x, y)
        return
      }

      if (clipboardCount() > 0) {
        e.preventDefault()
        const [x, y] = visibleCenter()
        void pasteNotes(x, y)
        return
      }

      const text = e.clipboardData?.getData('text/plain')?.trim()
      if (text) {
        e.preventDefault()
        void createNotesFromText(text)
      }
    }

    window.addEventListener('copy', onCopy)
    window.addEventListener('cut', onCut)
    window.addEventListener('paste', onPaste)
    return () => {
      window.removeEventListener('copy', onCopy)
      window.removeEventListener('cut', onCut)
      window.removeEventListener('paste', onPaste)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canEdit, roomId, zoom, images.rows.length, selectedNotes, notes.rows])

  // ---- テンプレート・書き出し ---------------------------------------------

  async function applyTemplate(template: BoardTemplate) {
    setShowTemplates(false)
    if (template.items.length === 0) return

    const now = new Date().toISOString()
    const maxZ = notes.rows.reduce((max, n) => Math.max(max, n.z), 0)
    const rows: Note[] = template.items.map((item, index) => ({
      id: crypto.randomUUID(),
      room_id: roomId,
      kind: item.kind,
      x: item.x,
      y: item.y,
      w: item.w,
      h: item.h,
      color: item.color,
      text: item.text,
      tags: [],
      z: maxZ + index + 1,
      font_size: 0,
      deleted_at: null,
      author_id: userId,
      author_name: displayName,
      created_at: now,
      updated_at: now,
    }))

    if (!(await insertNotes(rows))) return
    undoStack.push({
      label: `テンプレート「${template.name}」`,
      undo: () => must(deleteNotes(rows)),
      redo: () => must(insertNotes(rows)),
    })
  }

  /** 選んだ付箋だけを書き出すときの、まわりの余白 */
  const EXPORT_PADDING = 16

  /**
   * ボードの絵を作る。rows を渡すと、その付箋だけを外接矩形で切り出す。
   *
   * 切り出すときに手描き・画像・フレーム・ファイルを混ぜないのは、選択の対象が
   * 付箋だからで、「選んだものが出てくる」という見え方を崩さないため。
   * 線だけは例外で、両端とも選んだ付箋なら描く——線は付箋にぶら下がっていて
   * 単独では選べないので、付箋を選んだ時点で一緒に選んだことになる。
   */
  function renderPng(rows?: Note[]): Promise<Blob> {
    const box = rows?.length
      ? boundingBox(rows, {
          top: EXPORT_PADDING,
          right: EXPORT_PADDING,
          bottom: EXPORT_PADDING,
          left: EXPORT_PADDING,
        })
      : null

    const pickedIds = box ? new Set(rows!.map((note) => note.id)) : null

    return renderBoardToBlob({
      width: box ? box.w : BOARD_W,
      height: box ? box.h : BOARD_H,
      origin: box ? { x: box.x, y: box.y } : undefined,
      notes: box ? rows! : notes.rows,
      strokes: box ? [] : strokes.rows,
      images: box ? [] : images.rows,
      frames: box ? [] : frames.rows,
      connectors: pickedIds
        ? connectors.rows.filter(
            (c) => pickedIds.has(c.from_note_id) && pickedIds.has(c.to_note_id),
          )
        : connectors.rows,
      attachments: box ? [] : attachments.rows,
      imageUrls,
      background: theme === 'dark' ? '#f8fafc' : '#ffffff',
    })
  }

  /**
   * ボードの絵をクリップボードへ。
   *
   * Safari は「ユーザーの操作と地続きの流れ」で ClipboardItem を作らないと弾く。
   * blob を await してから渡すと間に合わないので、Promise のまま渡すこと。
   */
  async function copyPngToClipboard(rows?: Note[]) {
    setBusy('画像を作成中…')
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': renderPng(rows) })])
      setNotice(rows?.length ? '選んだ付箋の画像をコピーしました' : 'ボードの画像をコピーしました')
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'クリップボードにコピーできませんでした')
    } finally {
      setBusy(null)
    }
  }

  async function exportPng(rows?: Note[]) {
    setBusy('画像を作成中…')
    try {
      const blob = await renderPng(rows)
      const safeName = boardName.replace(/[\\/:*?"<>|]/g, '_') || 'board'
      downloadBlob(rows?.length ? `${safeName}_選択.png` : `${safeName}.png`, blob)
    } catch (e) {
      setNotice(messageOf(e))
    } finally {
      setBusy(null)
    }
  }

  // ---- 座標・範囲選択・パン -----------------------------------------------

  function boardPoint(e: { clientX: number; clientY: number }, element: HTMLElement): Point {
    const rect = element.getBoundingClientRect()
    return [
      ((e.clientX - rect.left) / rect.width) * BOARD_W,
      ((e.clientY - rect.top) / rect.height) * BOARD_H,
    ]
  }

  // ---- 選択 ---------------------------------------------------------------

  function selectAllNotes() {
    setSelectedIds(notes.rows.map((n) => n.id))
    dragOriginsRef.current = new Map(notes.rows.map((n) => [n.id, { x: n.x, y: n.y }]))
  }

  function clearSelection() {
    setSelectedIds([])
    setSelectedOther(null)
    setConnectFrom(null)
  }

  // ---- 右クリックメニュー -------------------------------------------------

  const closeMenu = useCallback(() => setMenu(null), [])

  /**
   * Shift + F10 / アプリケーションキーから開く。
   * 対象は選択中のもの、無ければボードそのもの。
   */
  function openMenuFromKeyboard() {
    const board = boardRef.current
    const container = scrollRef.current
    if (!board || !container) return

    // Windows では Shift+F10 が keydown と contextmenu の両方を出す。
    // 続けて飛んでくる contextmenu を無視させるための目印
    keyboardMenuAtRef.current = Date.now()

    const selectedId = selectedIds[0] ?? selectedOther?.id ?? null
    const el = selectedId
      ? container.querySelector<HTMLElement>(`[data-ctx-id="${CSS.escape(selectedId)}"]`)
      : null

    // 画面の外にある対象を基準にすると端に貼りついて出所が分からなくなるので、
    // 先に見える位置まで送ってから測る
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' })

    const rect = el?.getBoundingClientRect()
    const x = rect ? rect.left : window.innerWidth / 2
    const y = rect ? rect.bottom : window.innerHeight / 2
    const [bx, by] = boardPoint({ clientX: x, clientY: y }, board)

    setMenu({
      x,
      y,
      bx: Math.max(0, Math.min(BOARD_W, bx)),
      by: Math.max(0, Math.min(BOARD_H, by)),
      target: resolveTarget(el),
    })
  }

  /**
   * ツールバーの「⋯」から、右クリックと同じメニューを開く。
   *
   * 右クリックでしか出せない操作を作らないための入口。マウスを持っていない人、
   * 右クリックを使う習慣が無い人、タッチの人が、同じ場所に辿り着けるようにする。
   * ボタンの真下に出すので、押した場所と出る場所がつながって見える。
   */
  function openMenuAt(target: CtxTarget, anchor: DOMRect) {
    const board = boardRef.current
    if (!board) return
    const [bx, by] = boardPoint({ clientX: anchor.left, clientY: anchor.bottom }, board)
    setMenu({
      x: anchor.left,
      y: anchor.bottom,
      bx: Math.max(0, Math.min(BOARD_W, bx)),
      by: Math.max(0, Math.min(BOARD_H, by)),
      target,
    })
  }

  /** 右クリックされた要素から、どのオブジェクトの上かを辿る */
  function resolveTarget(el: HTMLElement | null): CtxTarget {
    const hit = el?.closest<HTMLElement>('[data-ctx-kind]')
    const kind = hit?.dataset.ctxKind
    const id = hit?.dataset.ctxId
    if (!kind || !id) return { kind: 'canvas', id: null }
    return { kind: kind as CtxTarget['kind'], id }
  }

  /**
   * メニューを出す前の選択。
   *
   * selectNote は使わない。あれは「最前面へ」の UPDATE をサーバーに送るので、
   * 右クリックのたびに全員へ z の更新が飛んでしまう。つなぐモードの状態機械にも入る。
   * すでに選ばれているものは触らない（3 枚選んだまま「3 件を削除」を出せるように）。
   */
  function selectForContextMenu(target: CtxTarget) {
    if (target.kind === 'canvas' || !target.id) return

    if (target.kind === 'note') {
      if (selectedIds.includes(target.id)) return
      const note = notes.rows.find((n) => n.id === target.id)
      if (!note) return
      setSelectedIds([note.id])
      setSelectedOther(null)
      dragOriginsRef.current = new Map([[note.id, { x: note.x, y: note.y }]])
      releaseDragHolds()
      return
    }

    setSelectedIds([])
    setSelectedOther({ kind: target.kind, id: target.id })
  }

  /**
   * ボードの上での右クリック。
   *
   * 入力欄とリンクの上ではブラウザ既定のメニューを残す。日本語入力の変換候補や
   * 「新しいタブで開く」を潰してしまうと、独自メニューの利便より損のほうが大きい。
   */
  function boardContextMenu(e: React.MouseEvent<HTMLDivElement>) {
    const el = e.target as HTMLElement | null
    if (isTypingTarget(el)) return
    if (el?.closest('a[href]')) return

    const board = boardRef.current
    if (!board) return

    e.preventDefault()

    // keydown 側ですでに開いていれば、こちらは何もしない。
    // Windows では Shift+F10 が keydown と contextmenu の両方を出すため
    if (Date.now() - keyboardMenuAtRef.current < 300) return

    // カーソルの座標に出す。詳しい理由は menuAnchor の説明を参照
    const focused = document.activeElement
    const focusedRect =
      focused && focused !== document.body ? focused.getBoundingClientRect() : null
    const { x, y } = menuAnchor({ x: e.clientX, y: e.clientY }, focusedRect, {
      w: window.innerWidth,
      h: window.innerHeight,
    })

    // ボードの外（余白のグレー部分）で押されると範囲外の値になるので収める
    const [bx, by] = boardPoint({ clientX: x, clientY: y }, board)

    const target = resolveTarget(el)
    selectForContextMenu(target)

    setMenu({
      x,
      y,
      bx: Math.max(0, Math.min(BOARD_W, bx)),
      by: Math.max(0, Math.min(BOARD_H, by)),
      target,
    })
  }

  function startBackgroundDrag(e: React.PointerEvent<HTMLDivElement>) {
    const board = e.currentTarget.parentElement as HTMLElement | null
    if (!board) return

    // 右クリックはここで降りる。降りないと下の範囲選択に入り、
    // contextmenu が届く前に選択が消えてしまう
    if (e.button === 2) return

    // スペースキー or 中ボタンで画面を掴んで移動
    if (spaceRef.current || e.button === 1) {
      const container = scrollRef.current
      if (!container) return
      e.currentTarget.setPointerCapture(e.pointerId)
      panRef.current = {
        x: e.clientX,
        y: e.clientY,
        left: container.scrollLeft,
        top: container.scrollTop,
      }
      setPanning(true)
      return
    }

    const [x, y] = boardPoint(e, board)
    marqueeStartRef.current = [x, y]
    e.currentTarget.setPointerCapture(e.pointerId)
    setMarquee({ x1: x, y1: y, x2: x, y2: y })
    setSelectedIds([])
    setSelectedOther(null)
  }

  function moveBackgroundDrag(e: React.PointerEvent<HTMLDivElement>) {
    if (panRef.current) {
      const container = scrollRef.current
      if (!container) return
      container.scrollLeft = panRef.current.left - (e.clientX - panRef.current.x)
      container.scrollTop = panRef.current.top - (e.clientY - panRef.current.y)
      return
    }

    const start = marqueeStartRef.current
    const board = e.currentTarget.parentElement as HTMLElement | null
    if (!start || !board) return
    const [x, y] = boardPoint(e, board)
    setMarquee({ x1: start[0], y1: start[1], x2: x, y2: y })
  }

  function endBackgroundDrag() {
    if (panRef.current) {
      panRef.current = null
      setPanning(false)
      return
    }

    const box = marquee
    marqueeStartRef.current = null
    setMarquee(null)
    if (!box) return

    const left = Math.min(box.x1, box.x2)
    const right = Math.max(box.x1, box.x2)
    const top = Math.min(box.y1, box.y2)
    const bottom = Math.max(box.y1, box.y2)
    if (right - left < 5 && bottom - top < 5) return

    const hit = notes.rows.filter(
      (n) => n.x < right && n.x + n.w > left && n.y < bottom && n.y + n.h > top,
    )
    setSelectedIds(hit.map((n) => n.id))
    dragOriginsRef.current = new Map(hit.map((n) => [n.id, { x: n.x, y: n.y }]))
    releaseDragHolds()
  }

  // ---- レイヤーに渡すハンドラ（identity を固定して memo を効かせる） -------

  const h = useStableHandlers({
    // フレーム
    selectFrame: (id: string | null) => setSelectedOther(id ? { kind: 'frame', id } : null),
    moveFrame,
    finishFrameMove: () => void finishFrameMove(),
    frameLocalChange: (frame: Frame) => frames.upsertLocal(frame),
    commitFrame,
    deleteFrame: (frame: Frame) => void deleteFrame(frame),
    // 背景（範囲選択・画面移動）
    startBackgroundDrag,
    moveBackgroundDrag,
    endBackgroundDrag,
    // 画像
    selectImage: (id: string | null) => setSelectedOther(id ? { kind: 'image', id } : null),
    imageLocalChange: (image: BoardImage) => images.upsertLocal(image),
    commitImage,
    deleteImage: (image: BoardImage) => void deleteImage(image),
    // 手描き
    commitStroke: (kind: StrokeKind, points: Point[], color: string, width: number) =>
      void commitStroke(kind, points, color, width),
    eraseStroke: (id: string) => void eraseStroke(id),
    // コネクタ
    selectConnector: (id: string | null) =>
      setSelectedOther(id ? { kind: 'connector', id } : null),
    // ファイル
    selectAttachment: (id: string | null) =>
      setSelectedOther(id ? { kind: 'attachment', id } : null),
    attachmentLocalChange: (attachment: Attachment) => attachments.upsertLocal(attachment),
    commitAttachment,
    deleteAttachment: (attachment: Attachment) => void deleteAttachment(attachment),
    // 付箋
    toggleReaction: (note: Note, emoji: string) => void toggleReaction(note, emoji),
    selectNote,
    moveSelection,
    finishMove: () => void finishMove(),
    noteLocalChange: (note: Note) => notes.upsertLocal(note),
    commitNote: (id: string, patch: Partial<Note>) => commitNote(id, patch),
    deleteNote: (note: Note) => void deleteNote(note),
    openComments: (note: Note) => setCommentTarget({ kind: 'note', note }),
    toggleVote: (note: Note) => void toggleVote(note),
    editingChange: (noteId: string | null) => onEditingChange(noteId),
    convert: (note: Note, target: 'todo' | 'event') => setConverting({ notes: [note], target }),
    openLink,
    // 一覧（狭い画面ではここが唯一の入口になるので、右クリックと同じ操作を渡す）
    copyOne: (note: Note) => copyNotes([note]),
    duplicateOne: (note: Note) => void duplicateNotes([note]),
    copyStyleOne: (note: Note) => {
      setClipboardStyle(note.color)
      setNotice('色をコピーしました')
    },
    pasteStyleOne: (note: Note) => {
      const color = getClipboardStyle()
      if (color) void applyStyleToNotes([note], color)
    },
    copyPngOne: (note: Note) => void copyPngToClipboard([note]),
    exportPngOne: (note: Note) => void exportPng([note]),
    addNoteInList: () => void createNoteInList(),
    swapNotes: (a: Note, b: Note) => void swapNotes(a, b),
    // 空のボード
    addNoteAtCenter: () => {
      const [x, y] = visibleCenter()
      void createNote(x, y, 'sticky')
    },
    pickTemplate: () => setShowTemplates(true),
    openShare: () => onOpenShare(),
    // 「⋯」から右クリックと同じメニューを開く
    openNoteMenu: (id: string, rect: DOMRect) => openMenuAt({ kind: 'note', id }, rect),
    openFrameMenu: (id: string, rect: DOMRect) => openMenuAt({ kind: 'frame', id }, rect),
    // ボード全体
    boardContextMenu,
    boardPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
      const [x, y] = boardPoint(e, e.currentTarget)
      onCursorMove(x, y, laser)
    },
    boardDrop: (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault()
      const file = e.dataTransfer.files[0]
      if (!file) return
      const [x, y] = boardPoint(e, e.currentTarget)
      void uploadFile(file, x, y)
    },
    placePointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
      const [x, y] = boardPoint(e, e.currentTarget)
      if (mode === 'frame') void createFrame(x, y)
      else void createNote(x, y, mode === 'textbox' ? 'text' : 'sticky')
    },
  })

  const menuActions: BoardMenuActions = {
    createNote: (x, y, kind) => void createNote(x, y, kind),
    createFrame: (x, y) => void createFrame(x, y),
    paste: (x, y) => void pasteNotes(x, y),
    selectAll: selectAllNotes,
    clearSelection,
    openTemplates: () => setShowTemplates(true),
    openBulk: () => setShowBulk(true),
    fitToScreen,
    copyPng: (rows) => void copyPngToClipboard(rows),
    exportPng: (rows) => void exportPng(rows),
    undo: () => void undoStack.undo(),
    redo: () => void undoStack.redo(),

    copyNotes,
    deleteNotes: (rows) => void deleteNoteRows(rows),
    duplicateNotes: (rows) => void duplicateNotes(rows),
    wrapInFrame: (rows) => void wrapSelectionInFrame(rows),
    copyStyle: (note) => {
      setClipboardStyle(note.color)
      setNotice('色をコピーしました')
    },
    pasteStyle: (rows) => {
      const color = getClipboardStyle()
      if (color) void applyStyleToNotes(rows, color)
    },
    openComments: (subject) => setCommentTarget(subject),
    convert: (rows, target) => setConverting({ notes: rows.slice(), target }),
    align: (kind) => void align(kind),
    changeZ: (rows, where) => void changeZ(rows, where),
    selectNotes: (rows) => {
      setSelectedIds(rows.map((n) => n.id))
      setSelectedOther(null)
      dragOriginsRef.current = new Map(rows.map((n) => [n.id, { x: n.x, y: n.y }]))
    },

    deleteImage: (image) => void deleteImage(image),
    deleteFrame: (frame) => void deleteFrame(frame),
    toggleConnectorStyle: (connector) =>
      commitConnector(
        connector.id,
        { style: connector.style === 'arrow' ? 'line' : 'arrow' },
        '線の向きの変更',
      ),
    deleteConnector: (connector) => void deleteConnector(connector),
    openUrl: (url) => {
      window.open(url, '_blank', 'noopener,noreferrer')
    },
    deleteAttachment: (attachment) => void deleteAttachment(attachment),
  }

  // ---- メニューの中身 -----------------------------------------------------

  /**
   * 開いたときのスナップショットではなく、描画のたびに組み直す。
   * 共同編集なので、メニューを開いている間に対象が消えたり権限が変わったりする。
   * 中身の組み立て自体は src/lib/boardMenu.ts（純粋な関数・テストあり）。
   */
  const menuNodes = menu
    ? buildBoardMenu(
        {
          target: menu.target,
          bx: menu.bx,
          by: menu.by,
          canEdit,
          notes: notes.rows,
          images: images.rows,
          frames: frames.rows,
          connectors: connectors.rows,
          attachments: attachments.rows,
          fileUrls,
          selectedIds,
          selectedNotes,
          hasOtherSelection: selectedOther !== null,
          clipboardCount: clipboardCount(),
          hasClipboardStyle: getClipboardStyle() !== null,
          busy: busy !== null,
          // Firefox の一部には ClipboardItem が無い
          canCopyImage: typeof ClipboardItem !== 'undefined',
          canUndo: undoStack.canUndo,
          canRedo: undoStack.canRedo,
          undoLabel: undoStack.undoLabel,
          redoLabel: undoStack.redoLabel,
        },
        menuActions,
      )
    : []

  /**
   * 開いている間に対象が消えたら閉じる。
   * 自分が消した場合だけでなく、共同編集で他の人に消される場合もある
   * （中身を組み立てる関数は、対象が見つからないと空の配列を返す）。
   */
  useEffect(() => {
    if (menu && menuNodes.length === 0) closeMenu()
  }, [menu, menuNodes.length, closeMenu])

  // ---- 描画 ---------------------------------------------------------------

  const multi = selectedIds.length > 1
  const selectedConnector =
    selectedOther?.kind === 'connector'
      ? connectors.rows.find((c) => c.id === selectedOther.id)
      : undefined
  const myStrokeCount = strokes.rows.filter((s) => s.author_id === userId).length

  return (
    <div className="flex h-full flex-col">
      {listView ? (
        <div className="flex items-center gap-2 border-b border-slate-200 bg-white px-3 py-2 print:hidden">
          <span className="min-w-0 flex-1 text-sm font-medium text-slate-600">
            📋 付箋の一覧（{notes.rows.length}）
          </span>
          <button
            type="button"
            onClick={() => setViewChoice('board')}
            className="shrink-0 rounded-full border border-slate-200 px-3 py-1 text-sm text-slate-600 transition hover:bg-slate-50"
          >
            🖍️ ボードで開く
          </button>
        </div>
      ) : (
        <div className="toolbar-scroll flex items-center gap-x-3 gap-y-2 border-b border-slate-200 bg-white px-3 py-2 print:hidden">
          <div className="flex shrink-0 gap-1" role="group" aria-label="置くもの">
            {PLACE_TOOLS.map((t) => (
              <ToolButton
                key={t.key}
                active={mode === t.key}
                label={`${t.label}（${t.hotkey.toUpperCase()}）`}
                icon={t.icon}
                showLabel={t.key === 'select' || t.key === 'note'}
                disabled={!canEdit && t.key !== 'select'}
                onClick={() => setMode(t.key)}
              />
            ))}
          </div>

          {canEdit && (
            <>
              <span className="h-5 w-px shrink-0 bg-slate-200" />
              <div className="flex shrink-0 gap-1" role="group" aria-label="描くもの">
                {DRAW_TOOLS.map((t) => (
                  <ToolButton
                    key={t.key}
                    active={mode === t.key}
                    label={`${t.label}（${t.hotkey.toUpperCase()}）`}
                    icon={t.icon}
                    onClick={() => setMode(t.key)}
                  />
                ))}
              </div>
            </>
          )}

          {isDrawing && mode !== 'eraser' && (
            <>
              <div className="flex shrink-0 items-center gap-1.5" role="group" aria-label="ペンの色">
                {PEN_COLORS.map((c) => {
                  const label = PEN_COLOR_LABELS[c] ?? c
                  return (
                    <button
                      key={c}
                      type="button"
                      title={label}
                      aria-label={label}
                      aria-pressed={penColor === c}
                      onClick={() => setPenColor(c)}
                      className={`h-5 w-5 shrink-0 rounded-full transition ${
                        penColor === c ? 'ring-2 ring-slate-800 ring-offset-2' : ''
                      }`}
                      style={{ background: c }}
                    />
                  )
                })}
              </div>
              <div className="flex shrink-0 items-center gap-1" role="group" aria-label="ペンの太さ">
                {PEN_WIDTHS.map((w) => (
                  <button
                    key={w}
                    type="button"
                    title={`太さ ${w}`}
                    aria-label={`太さ ${w}`}
                    aria-pressed={penWidth === w}
                    onClick={() => setPenWidth(w)}
                    className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg transition ${
                      penWidth === w ? 'bg-slate-900' : 'hover:bg-slate-100'
                    }`}
                  >
                    <span
                      className="rounded-full"
                      style={{
                        width: w + 2,
                        height: w + 2,
                        background: penWidth === w ? '#fff' : '#475569',
                      }}
                    />
                  </button>
                ))}
              </div>
            </>
          )}

          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {canEdit && (
              <>
                <IconTool title="画像を貼る" onClick={() => imageInputRef.current?.click()}>
                  🖼
                </IconTool>
                <IconTool title="ファイルを置く（PDF など）" onClick={() => fileInputRef.current?.click()}>
                  📎
                </IconTool>
                <IconTool title="テキストからまとめて付箋を作る" onClick={() => setShowBulk(true)}>
                  📋
                </IconTool>
                <IconTool title="テンプレート" onClick={() => setShowTemplates(true)}>
                  📐
                </IconTool>
                <IconTool title="グリッドに吸着" active={snap} onClick={() => setSnap((v) => !v)}>
                  ⊞
                </IconTool>
                <IconTool
                  title="レーザーポインター（押している間だけ相手の画面で光ります）"
                  active={laser}
                  onClick={() => setLaser((v) => !v)}
                >
                  🔦
                </IconTool>
              </>
            )}

            <IconTool title="付箋を一覧で開く（スマホ向け）" onClick={() => setViewChoice('list')}>
              📋
            </IconTool>
            {/* 引数なしで呼ぶ。関数をそのまま渡すとクリックイベントが rows に入る */}
            <IconTool title="ボードを PNG で保存" onClick={() => void exportPng()}>
              📥
            </IconTool>
            {/* 「クリップボードへ」は右クリックからしか出せなかった */}
            {typeof ClipboardItem !== 'undefined' && (
              <IconTool
                title="ボードの画像をクリップボードにコピー"
                onClick={() => void copyPngToClipboard()}
              >
                🖼
              </IconTool>
            )}
            <IconTool title="全体を画面に収める（Shift+H）" onClick={fitToScreen}>
              ⛶
            </IconTool>
            <IconTool title="ショートカット一覧（?）" onClick={onOpenShortcuts}>
              ⌨
            </IconTool>

            {canEdit && (
              <>
                <div className="flex items-center gap-1 rounded-lg border border-slate-200">
                  <button
                    type="button"
                    title={undoStack.undoLabel ? `元に戻す: ${undoStack.undoLabel}` : '元に戻す'}
                    aria-label={undoStack.undoLabel ? `元に戻す: ${undoStack.undoLabel}` : '元に戻す'}
                    onClick={() => void undoStack.undo()}
                    disabled={!undoStack.canUndo}
                    className="px-2 py-1 text-slate-600 transition hover:bg-slate-100 disabled:text-slate-300"
                  >
                    ↶
                  </button>
                  <button
                    type="button"
                    title={undoStack.redoLabel ? `やり直す: ${undoStack.redoLabel}` : 'やり直す'}
                    aria-label={undoStack.redoLabel ? `やり直す: ${undoStack.redoLabel}` : 'やり直す'}
                    onClick={() => void undoStack.redo()}
                    disabled={!undoStack.canRedo}
                    className="px-2 py-1 text-slate-600 transition hover:bg-slate-100 disabled:text-slate-300"
                  >
                    ↷
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => setShowClearStrokes(true)}
                  disabled={strokes.rows.length === 0}
                  className="rounded-lg px-2 py-1.5 text-sm whitespace-nowrap text-slate-500 transition hover:bg-slate-100 hover:text-rose-600 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-slate-500"
                >
                  線を全消去
                </button>
              </>
            )}

            <div className="flex items-center gap-1 rounded-lg border border-slate-200">
              <button
                type="button"
                aria-label="縮小"
                onClick={() => setZoom((z) => Math.max(MIN_ZOOM, +(z - 0.1).toFixed(2)))}
                className="px-2 py-1 text-slate-600 transition hover:bg-slate-100"
              >
                −
              </button>
              <span className="w-12 text-center text-xs text-slate-500">
                {Math.round(zoom * 100)}%
              </span>
              <button
                type="button"
                aria-label="拡大"
                onClick={() => setZoom((z) => Math.min(MAX_ZOOM, +(z + 0.1).toFixed(2)))}
                className="px-2 py-1 text-slate-600 transition hover:bg-slate-100"
              >
                ＋
              </button>
            </div>
          </div>

          <input
            ref={imageInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (!file) return
              const [x, y] = visibleCenter()
              void uploadImage(file, x, y)
            }}
          />
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (!file) return
              const [x, y] = visibleCenter()
              void uploadFile(file, x, y)
            }}
          />
        </div>
      )}

      {!listView && mode === 'connect' && (
        <div className="border-b border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-800 print:hidden">
          {connectFrom
            ? 'つなぎ先の付箋をクリックしてください。'
            : 'つなぎ元の付箋をクリックしてください。'}
        </div>
      )}

      {!listView && selectedConnector && canEdit && (
        <div className="toolbar-scroll flex items-center gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2 print:hidden">
          <span className="shrink-0 text-sm text-slate-600">線</span>
          <button
            type="button"
            onClick={() =>
              void patchConnector(selectedConnector.id, {
                style: selectedConnector.style === 'arrow' ? 'line' : 'arrow',
              })
            }
            className="shrink-0 rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-sm text-slate-700 transition hover:bg-slate-100"
          >
            {selectedConnector.style === 'arrow' ? '矢印' : '直線'}
          </button>
          <div className="flex shrink-0 items-center gap-1" role="group" aria-label="線の色">
            {PEN_COLORS.map((c) => {
              const label = PEN_COLOR_LABELS[c] ?? c
              return (
                <button
                  key={c}
                  type="button"
                  title={label}
                  aria-label={`${label}にする`}
                  aria-pressed={selectedConnector.color === c}
                  onClick={() => void patchConnector(selectedConnector.id, { color: c })}
                  className="h-5 w-5 rounded-full border border-slate-300"
                  style={{ background: c }}
                />
              )
            })}
          </div>
          <ConnectorLabelInput
            key={selectedConnector.id}
            value={selectedConnector.label}
            onCommit={(label) => void patchConnector(selectedConnector.id, { label })}
          />
          <button
            type="button"
            onClick={() => void deleteConnector(selectedConnector)}
            className="shrink-0 rounded-lg px-2 py-1 text-sm text-slate-500 transition hover:bg-white hover:text-rose-600"
          >
            削除
          </button>
        </div>
      )}

      {!listView && canEdit && multi && (
        <div className="toolbar-scroll flex items-center gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2 print:hidden">
          <span className="shrink-0 text-sm text-slate-600">{selectedIds.length} 件を選択中</span>
          <span className="h-4 w-px shrink-0 bg-slate-300" />
          <AlignButton onClick={() => align('left')}>左揃え</AlignButton>
          <AlignButton onClick={() => align('top')}>上揃え</AlignButton>
          <AlignButton onClick={() => align('row')}>横に並べる</AlignButton>
          <AlignButton onClick={() => align('column')}>縦に並べる</AlignButton>
          <AlignButton onClick={() => align('grid')}>グリッドに揃える</AlignButton>
          <span className="h-4 w-px shrink-0 bg-slate-300" />
          <div className="flex shrink-0 items-center gap-1" role="group" aria-label="まとめて色を変える">
            {Object.entries(NOTE_COLORS).map(([key, c]) => (
              <button
                key={key}
                type="button"
                title={`まとめて${c.label}にする`}
                aria-label={`まとめて${c.label}にする`}
                onClick={() => {
                  for (const note of selectedNotes) void applyNotePatch(note.id, { color: key })
                }}
                className="h-5 w-5 rounded-full border border-slate-300"
                style={{ background: c.bg }}
              />
            ))}
          </div>
          <span className="h-4 w-px shrink-0 bg-slate-300" />
          <button
            type="button"
            onClick={() => setConverting({ notes: selectedNotes.slice(), target: 'todo' })}
            className="shrink-0 rounded-lg px-2 py-1 text-sm text-slate-600 transition hover:bg-white hover:text-slate-900"
          >
            ⏰ まとめてやることにする
          </button>
          {/* 「やること」だけがあって「予定」が無い非対称を埋める */}
          <button
            type="button"
            onClick={() => setConverting({ notes: selectedNotes.slice(), target: 'event' })}
            className="shrink-0 rounded-lg px-2 py-1 text-sm text-slate-600 transition hover:bg-white hover:text-slate-900"
          >
            📅 まとめて予定にする
          </button>
          {/* 複製・重なり順・PNG は、ここからも届くようにする */}
          <button
            type="button"
            aria-label="そのほかの操作"
            aria-haspopup="menu"
            onClick={(e) => {
              const id = selectedIds[0]
              if (id) openMenuAt({ kind: 'note', id }, e.currentTarget.getBoundingClientRect())
            }}
            className="shrink-0 rounded-lg px-2 py-1 text-sm text-slate-600 transition hover:bg-white hover:text-slate-900"
          >
            ⋯ そのほか
          </button>
          <button
            type="button"
            onClick={() => void deleteSelection()}
            className="shrink-0 rounded-lg px-2 py-1 text-sm text-slate-500 transition hover:bg-white hover:text-rose-600"
          >
            まとめて削除
          </button>
          <button
            type="button"
            onClick={() => setSelectedIds([])}
            className="shrink-0 text-sm text-slate-400 transition hover:text-slate-700"
          >
            選択解除
          </button>
        </div>
      )}

      {(notice || busy) && (
        <div
          role="status"
          className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800 print:hidden"
        >
          {notice ?? busy}
        </div>
      )}

      {created && (
        <div className="flex items-center gap-3 border-b border-green-200 bg-green-50 px-4 py-2 text-sm text-green-800 print:hidden">
          <span className="min-w-0 flex-1">{created.text}</span>
          <button
            type="button"
            onClick={() => {
              onJump(created.tab, created.id)
              setCreated(null)
            }}
            className="shrink-0 rounded-lg border border-green-300 px-2.5 py-1 text-xs font-medium transition hover:bg-white"
          >
            見る →
          </button>
          <button
            type="button"
            onClick={() => setCreated(null)}
            aria-label="閉じる"
            className="shrink-0 text-green-600 transition hover:text-green-900"
          >
            ✕
          </button>
        </div>
      )}

      {listView ? (
        <NotesListView
          notes={notes.rows}
          canEdit={canEdit}
          linkCounts={linkCounts}
          editingByOthers={editingByOthers}
          commentCounts={noteCommentCounts}
          onAdd={h.addNoteInList}
          onCommit={h.commitNote}
          onDelete={h.deleteNote}
          onConvert={h.convert}
          onOpenComments={h.openComments}
          onSwap={h.swapNotes}
          onEditingChange={h.editingChange}
          onCopy={h.copyOne}
          onDuplicate={h.duplicateOne}
          onCopyStyle={h.copyStyleOne}
          onPasteStyle={h.pasteStyleOne}
          onCopyPng={h.copyPngOne}
          onExportPng={h.exportPngOne}
          hasClipboardStyle={getClipboardStyle() !== null}
          canCopyImage={typeof ClipboardItem !== 'undefined'}
        />
      ) : (
        <div
          ref={scrollRef}
          tabIndex={-1}
          onContextMenu={h.boardContextMenu}
          className="relative min-h-0 flex-1 touch-pan-x touch-pan-y overflow-auto bg-slate-200 p-4 outline-none sm:p-6"
        >
          <div style={{ width: BOARD_W * zoom, height: BOARD_H * zoom }}>
            <div
              ref={boardRef}
              className="relative bg-white shadow-lg"
              style={{
                width: BOARD_W,
                height: BOARD_H,
                transform: `scale(${zoom})`,
                transformOrigin: 'top left',
                // グリッドの点。ダークでは bg-white が暗くなるので点も暗めにする
                backgroundImage: `radial-gradient(circle, ${
                  theme === 'dark' ? '#2a3548' : '#e2e8f0'
                } 1px, transparent 1px)`,
                backgroundSize: `${GRID}px ${GRID}px`,
              }}
              onPointerMove={h.boardPointerMove}
              onDragOver={(e) => e.preventDefault()}
              onDrop={h.boardDrop}
            >
              {/*
                背景。範囲選択と画面移動を受け取る。

                フレームより前に置く。どちらも z-0 の兄弟なので、あとに書いたほうが
                上に乗る。背景をあとに置いていたころは、フレームの名前バー
                （枠の外に出ている）が背景に覆われて掴めなかった——選べないので
                色も名前も変えられず、🗑 も ⋯ も出てこなかった。
                ここより後ろに書いてある画像・付箋などは、これまでどおり背景の上。
              */}
              {mode === 'select' && (
                <div
                  className={`absolute inset-0 z-0 touch-none ${panning ? 'cursor-grabbing' : ''}`}
                  onPointerDown={h.startBackgroundDrag}
                  onPointerMove={h.moveBackgroundDrag}
                  onPointerUp={h.endBackgroundDrag}
                  onPointerCancel={h.endBackgroundDrag}
                  onLostPointerCapture={h.endBackgroundDrag}
                />
              )}

              <FramesLayer
                frames={frames.rows}
                interactive={mode === 'select'}
                canEdit={canEdit}
                zoom={zoom}
                selectedId={selectedOther?.kind === 'frame' ? selectedOther.id : null}
                onSelect={h.selectFrame}
                onDragMove={h.moveFrame}
                onDragEnd={h.finishFrameMove}
                onLocalChange={h.frameLocalChange}
                onCommit={h.commitFrame}
                onDelete={h.deleteFrame}
                onOpenMenu={h.openFrameMenu}
              />

              <ImagesLayer
                images={images.rows}
                urls={imageUrls}
                interactive={mode === 'select' && canEdit}
                zoom={zoom}
                selectedId={selectedOther?.kind === 'image' ? selectedOther.id : null}
                onSelect={h.selectImage}
                onLocalChange={h.imageLocalChange}
                onCommit={h.commitImage}
                onDelete={h.deleteImage}
              />

              <DrawLayer
                width={BOARD_W}
                height={BOARD_H}
                strokes={strokes.rows}
                active={isDrawing}
                tool={isDrawing ? (mode as DrawTool) : 'pen'}
                color={penColor}
                lineWidth={penWidth}
                cancelNonce={gestureNonce}
                onCommit={h.commitStroke}
                onErase={h.eraseStroke}
              />

              <ConnectorsLayer
                width={BOARD_W}
                height={BOARD_H}
                connectors={connectors.rows}
                notes={notes.rows}
                interactive={mode === 'select' && canEdit}
                selectedId={selectedOther?.kind === 'connector' ? selectedOther.id : null}
                onSelect={h.selectConnector}
              />

              <AttachmentsLayer
                attachments={attachments.rows}
                urls={fileUrls}
                interactive={mode === 'select'}
                canEdit={canEdit}
                zoom={zoom}
                selectedId={selectedOther?.kind === 'attachment' ? selectedOther.id : null}
                onSelect={h.selectAttachment}
                onLocalChange={h.attachmentLocalChange}
                onCommit={h.commitAttachment}
                onDelete={h.deleteAttachment}
              />

              <NotesLayer
                notes={notes.rows}
                interactive={mode === 'select' || mode === 'connect'}
                canEdit={canEdit && mode === 'select'}
                zoom={zoom}
                selectedIds={selectedIds}
                highlightId={focusId}
                voteCounts={voteCounts}
                myVotes={myVotes}
                reactions={reactionMap}
                connectFromId={connectFrom}
                editingByOthers={editingByOthers}
                commentCounts={noteCommentCounts}
                linkCounts={linkCounts}
                onToggleReaction={h.toggleReaction}
                onSelect={h.selectNote}
                onDragMove={h.moveSelection}
                onDragEnd={h.finishMove}
                onLocalChange={h.noteLocalChange}
                onCommit={h.commitNote}
                onDelete={h.deleteNote}
                onOpenComments={h.openComments}
                onOpenMenu={h.openNoteMenu}
                onToggleVote={h.toggleVote}
                onEditingChange={h.editingChange}
                onConvert={h.convert}
                onOpenLink={h.openLink}
              />

              {marquee && (
                <div
                  className="pointer-events-none absolute z-30 border-2 border-blue-500 bg-blue-500/10"
                  style={{
                    left: Math.min(marquee.x1, marquee.x2),
                    top: Math.min(marquee.y1, marquee.y2),
                    width: Math.abs(marquee.x2 - marquee.x1),
                    height: Math.abs(marquee.y2 - marquee.y1),
                  }}
                />
              )}

              <CursorsLayer peers={peers} meId={userId} />

              {(mode === 'note' || mode === 'textbox' || mode === 'frame') && (
                <div
                  // ブラウザのテストから「置く場所」を指すための目印
                  data-place-surface
                  className="absolute inset-0 z-30 cursor-crosshair touch-none"
                  onPointerDown={h.placePointerDown}
                />
              )}
            </div>
          </div>

          {boardEmpty && (
            <BoardEmptyState
              canEdit={canEdit}
              onAddNote={h.addNoteAtCenter}
              onPickTemplate={h.pickTemplate}
              onOpenShare={h.openShare}
            />
          )}
        </div>
      )}

      {commentTarget && (
        <Modal
          title={COMMENT_TARGET_LABELS[commentTarget.kind]}
          onClose={() => setCommentTarget(null)}
        >
          {/* 何に付けているのかが分かるように、対象そのものを上に出す */}
          {commentTarget.kind === 'note' && (
            <p className="mb-4 rounded-lg bg-slate-50 p-3 text-sm whitespace-pre-wrap text-slate-700">
              {commentTarget.note.text || '（空の付箋）'}
            </p>
          )}

          {commentTarget.kind === 'image' && (
            <div className="mb-4 rounded-lg bg-slate-50 p-3">
              {imageUrls[commentTarget.image.storage_path] ? (
                <img
                  src={imageUrls[commentTarget.image.storage_path]}
                  alt=""
                  className="mx-auto max-h-40 rounded"
                />
              ) : (
                <p className="text-center text-sm text-slate-400">読み込み中…</p>
              )}
            </div>
          )}

          {commentTarget.kind === 'file' && (
            <p className="mb-4 flex items-center gap-2 rounded-lg bg-slate-50 p-3 text-sm text-slate-700">
              <span className="text-xl leading-none">
                {attachmentIcon(commentTarget.attachment.mime, commentTarget.attachment.filename)}
              </span>
              <span className="min-w-0 flex-1 break-all">
                {commentTarget.attachment.filename}
              </span>
              <span className="shrink-0 text-xs text-slate-400">
                {formatFileSize(commentTarget.attachment.size)}
              </span>
            </p>
          )}

          {commentTarget.kind === 'frame' && (
            <p className="mb-4 rounded-lg bg-slate-50 p-3 text-sm text-slate-700">
              {commentTarget.frame.title || '（名前のないフレーム）'}
            </p>
          )}

          {/* タグを持てるのは付箋だけ（ほかの 3 つに tags の列が無い） */}
          {commentTarget.kind === 'note' && (
            <div className="mb-4">
              <span className="mb-1.5 block text-sm font-medium text-slate-700">タグ</span>
              <TagInput
                tags={commentTarget.note.tags ?? []}
                suggestions={allTags}
                disabled={!canEdit}
                onChange={(tags) => {
                  const note = { ...commentTarget.note, tags }
                  setCommentTarget({ kind: 'note', note })
                  commitNote(note.id, { tags }, 'タグの変更')
                }}
              />
            </div>
          )}

          <div className="border-t border-slate-100 pt-4">
            <CommentList
              targetType={commentTarget.kind}
              targetId={commentSubjectId(commentTarget)}
            />
          </div>
        </Modal>
      )}

      {showTemplates && (
        <Modal title="テンプレート" onClose={() => setShowTemplates(false)}>
          <ul className="space-y-2">
            {BOARD_TEMPLATES.map((template) => (
              <li key={template.key}>
                <button
                  type="button"
                  onClick={() => void applyTemplate(template)}
                  className="w-full rounded-xl border border-slate-200 p-4 text-left transition hover:border-slate-400"
                >
                  <span className="block font-medium text-slate-800">{template.name}</span>
                  <span className="mt-0.5 block text-xs text-slate-500">
                    {template.description}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-xs text-slate-400">
            いま置いてあるものは消えません。テンプレートの付箋が追加されるだけです。
          </p>
        </Modal>
      )}

      {showBulk && <BulkNotesModal onClose={() => setShowBulk(false)} onSubmit={createNotesFromText} />}

      {showClearStrokes && (
        <ClearStrokesModal
          mine={myStrokeCount}
          all={strokes.rows.length}
          onClear={(scope) => void clearStrokes(scope)}
          onClose={() => setShowClearStrokes(false)}
        />
      )}

      {converting && (
        <ConvertModal
          notes={converting.notes}
          initialTarget={converting.target}
          allTags={allTags}
          members={memberOptions}
          onSubmit={runConvert}
          onClose={() => setConverting(null)}
        />
      )}

      {/*
        ズームしているボード（transform: scale）の外に置くこと。
        中に入れると position: fixed の基準がボードになり、メニューまで倍率で
        拡大縮小されて位置もずれる。詳しくは ContextMenu.tsx の説明を参照
      */}
      {menu && menuNodes.length > 0 && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          nodes={menuNodes}
          label={MENU_LABELS[menu.target.kind]}
          onClose={closeMenu}
          fallbackFocus={scrollRef}
        />
      )}
    </div>
  )
}

/** 一覧の並び順を、ボード上の升目に対応させる */
function gridPosition(index: number): { x: number; y: number } {
  const perRow = 4
  return {
    x: 40 + (index % perRow) * 240,
    y: 40 + Math.floor(index / perRow) * 190,
  }
}

/**
 * コネクタのラベル入力。
 * 1 文字ごとに UPDATE を送らず、フォーカスが外れたか Enter を押したときにまとめて保存する。
 * 入力中でないときだけ、他の人の変更を取り込む。
 */
function ConnectorLabelInput({
  value,
  onCommit,
}: {
  value: string
  onCommit: (label: string) => void
}) {
  const [draft, setDraft] = useState(value)
  const [focused, setFocused] = useState(false)

  useEffect(() => {
    if (!focused) setDraft(value)
  }, [value, focused])

  return (
    <input
      value={draft}
      maxLength={20}
      placeholder="ラベル"
      aria-label="線のラベル"
      onChange={(e) => setDraft(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false)
        if (draft !== value) onCommit(draft)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
      }}
      className="w-32 shrink-0 rounded-lg border border-slate-300 px-2 py-1 text-sm outline-none focus:border-slate-800"
    />
  )
}

function BulkNotesModal({
  onClose,
  onSubmit,
}: {
  onClose: () => void
  onSubmit: (text: string) => Promise<void>
}) {
  const [text, setText] = useState('')
  const lines = text.split('\n').filter((l) => l.trim()).length

  return (
    <Modal
      title="テキストから付箋をまとめて作る"
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-600 transition hover:bg-slate-50"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={() => void onSubmit(text)}
            disabled={lines === 0}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-700 disabled:bg-slate-300"
          >
            {lines > 0 ? `${Math.min(lines, 60)} 枚つくる` : 'つくる'}
          </button>
        </>
      }
    >
      <p className="mb-3 text-sm text-slate-600">
        1 行につき 1 枚の付箋になります。行頭の「-」「・」は取り除かれます（最大 60 枚）。
      </p>
      <textarea
        autoFocus
        rows={10}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={'例）\n- 受付の動線を見直す\n- 案内表示を大きくする\n- 待ち時間を表示する'}
        className="w-full resize-none rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-800"
      />
    </Modal>
  )
}

/**
 * 線の全消去の確認。
 * 「自分の線だけ」を選べるようにして、他の人の線をうっかり消さないようにする。
 */
function ClearStrokesModal({
  mine,
  all,
  onClear,
  onClose,
}: {
  mine: number
  all: number
  onClear: (scope: 'mine' | 'all') => void
  onClose: () => void
}) {
  return (
    <Modal
      title="線を全消去"
      onClose={onClose}
      footer={
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-600 transition hover:bg-slate-50"
        >
          キャンセル
        </button>
      }
    >
      <p className="mb-4 text-sm text-slate-600">
        手描きの線と図形をまとめて消します。消したあとは「元に戻す」（Ctrl+Z）か、
        ゴミ箱から戻せます。
      </p>
      <div className="space-y-2">
        <button
          type="button"
          autoFocus
          disabled={mine === 0}
          onClick={() => onClear('mine')}
          className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-left text-sm text-slate-800 transition hover:border-slate-500 disabled:opacity-40"
        >
          <span className="block font-medium">自分の線 {mine} 本を消す</span>
          <span className="mt-0.5 block text-xs text-slate-500">他の人が描いた線は残ります</span>
        </button>
        <button
          type="button"
          disabled={all === 0}
          onClick={() => onClear('all')}
          className="w-full rounded-xl border border-rose-200 bg-white px-4 py-3 text-left text-sm text-rose-700 transition hover:border-rose-400 disabled:opacity-40"
        >
          <span className="block font-medium">全員の線 {all} 本を消す</span>
          <span className="mt-0.5 block text-xs text-slate-500">
            他の人が描いた線も消えます（戻せるのは自分の画面からだけ）
          </span>
        </button>
      </div>
    </Modal>
  )
}

function ToolButton({
  active,
  label,
  icon,
  showLabel = false,
  disabled = false,
  onClick,
}: {
  active: boolean
  label: string
  icon: string
  showLabel?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={`shrink-0 rounded-lg px-2.5 py-1.5 text-sm transition disabled:opacity-40 ${
        active ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
      }`}
    >
      <span className={showLabel ? 'mr-1' : ''}>{icon}</span>
      {showLabel && <span className="hidden xl:inline">{label.split('（')[0]}</span>}
    </button>
  )
}

function IconTool({
  title,
  active,
  onClick,
  children,
}: {
  title: string
  /** 渡したときだけトグルボタン扱い（aria-pressed を出す） */
  active?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active === undefined ? undefined : active}
      onClick={onClick}
      className={`shrink-0 rounded-lg px-2 py-1.5 text-sm transition ${
        active ? 'bg-slate-900 text-white' : 'text-slate-500 hover:bg-slate-100'
      }`}
    >
      {children}
    </button>
  )
}

function AlignButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="shrink-0 rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-sm whitespace-nowrap text-slate-700 transition hover:bg-slate-100"
    >
      {children}
    </button>
  )
}
