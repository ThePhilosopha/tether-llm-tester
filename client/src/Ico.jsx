import {
  ChatBubbleLeftRightIcon,
  Squares2X2Icon,
  ServerStackIcon,
  ScaleIcon,
  SparklesIcon,
  BoltIcon,
  ClipboardDocumentListIcon,
  BookmarkIcon,
  AdjustmentsHorizontalIcon,
  ClockIcon,
  Cog6ToothIcon
} from '@heroicons/react/24/outline';

const MAP = {
  chat: ChatBubbleLeftRightIcon,
  inventory: Squares2X2Icon,
  server: ServerStackIcon,
  scales: ScaleIcon,
  sparkles: SparklesIcon,
  plug: BoltIcon,
  list: ClipboardDocumentListIcon,
  pin: BookmarkIcon,
  template: AdjustmentsHorizontalIcon,
  clock: ClockIcon,
  cog: Cog6ToothIcon
};

export default function Ico({ name, className = 'size-4' }) {
  const Cmp = MAP[name];
  if (!Cmp) return null;
  return <Cmp className={`${className} shrink-0`} aria-hidden />;
}