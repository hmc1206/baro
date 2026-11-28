// 목록 아이콘 (lucide 선 아이콘). Item.glyph에 이름을 넣으면 아이콘으로, 아니면 글자로 표시
import {
  AppWindow, Calculator, FolderSearch, Waypoints, Plus, Pin, PinOff, Contrast, Download, ExternalLink, File, FileText, Globe, Keyboard, Lock, Maximize2,
  Moon, PanelBottom, PanelLeft, PanelRight, PanelTop, Power, Puzzle, Search, Settings, ShieldCheck, Sparkles,
  Square, Terminal, TextQuote, Trash2, TriangleAlert, VolumeX, GraduationCap, Circle, CircleDot, CircleCheck,
  NotebookPen, Lightbulb, CircleAlert, SquareTerminal, ClipboardPaste, CalendarDays, Pause, BookOpenText, ImagePlus, ImageMinus, House, ListChecks, type LucideIcon,
} from "lucide-react";

export const ICONS: Record<string, LucideIcon> = {
  app: AppWindow, calc: Calculator, folder: FolderSearch, graph: Waypoints, plus: Plus, pin: Pin, pinOff: PinOff, contrast: Contrast, download: Download, link: ExternalLink, file: File,
  doc: FileText, globe: Globe, keyboard: Keyboard, lock: Lock, max: Maximize2, moon: Moon, bottom: PanelBottom,
  left: PanelLeft, right: PanelRight, top: PanelTop, power: Power, puzzle: Puzzle, search: Search,
  settings: Settings, shield: ShieldCheck, ai: Sparkles, center: Square, terminal: Terminal, snippet: TextQuote,
  trash: Trash2, warn: TriangleAlert, mute: VolumeX,
  curriculum: GraduationCap, todo: Circle, doing: CircleDot, done: CircleCheck,
  memo: NotebookPen, learn: Lightbulb, stuck: CircleAlert, cmdlog: SquareTerminal, clip: ClipboardPaste, daily: CalendarDays, pause: Pause, notesAi: BookOpenText, image: ImagePlus, imageOff: ImageMinus, home: House, tasks: ListChecks,
};
