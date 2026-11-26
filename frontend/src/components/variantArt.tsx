/** What each experiment's options look like on a tile, so people can tell them apart before trying them. */
import { For, type JSX } from 'solid-js';
import { MUSIC_PACKS, musicPack, packOfExperiment } from '../lib/musicPacks';

export interface Art {
  bg: string;
  ring: string;
  art: () => JSX.Element;
  note: string;
}

const emoji = (e: string) => () => <span class="text-2xl leading-none drop-shadow-[0_2px_4px_rgb(0_0_0/0.5)]">{e}</span>;
const icon = (src: string, round = false) => () => (
  <img src={src} alt="" class={`size-9 drop-shadow-[0_2px_4px_rgb(0_0_0/0.6)] ${round ? 'rounded-full' : ''}`} />
);

/** Each music pack's tile: its colours and picture (the note comes from musicPacks.ts). */
const PACK_ART: Record<string, Omit<Art, 'note'>> = {
  deadlock: { bg: 'bg-[linear-gradient(135deg,#d9f891,#5f7a3a_55%,#171c18)]', ring: 'ring-[#d9f891]', art: icon('/images/deadlock-icon.webp', true) },
  hideout: { bg: 'bg-[linear-gradient(135deg,#7f86d6,#363b78_55%,#121428)]', ring: 'ring-[#9aa2ff]', art: emoji('🎧') },
  matchmaking: { bg: 'bg-[linear-gradient(135deg,#7fd6c4,#2d6b60_55%,#0f2420)]', ring: 'ring-[#8fe6d4]', art: emoji('⏳') },
  hotel: { bg: 'bg-[linear-gradient(135deg,#a47243,#4a2f1a_55%,#1c130c)]', ring: 'ring-[#e0b070]', art: emoji('🎷') },
  curio: { bg: 'bg-[linear-gradient(135deg,#c79a5a,#5e3f22_55%,#1f150b)]', ring: 'ring-[#e8c07c]', art: emoji('🗝️') },
  seasonal: { bg: 'bg-[linear-gradient(135deg,#bfe3ff,#3f6d93_55%,#0f1c2b)]', ring: 'ring-[#cfeaff]', art: emoji('❄️') },
  waltz: { bg: 'bg-[linear-gradient(135deg,#9fd18b,#3f6b33_55%,#142211)]', ring: 'ring-[#b5e3a0]', art: emoji('🌿') },
  choir: { bg: 'bg-[linear-gradient(135deg,#9a5b7e,#43233a_55%,#160c13)]', ring: 'ring-[#d68ab5]', art: emoji('🕯️') },
  teleporter: { bg: 'bg-[linear-gradient(135deg,#5fb6d6,#25536a_55%,#0b1a22)]', ring: 'ring-[#7fd3f0]', art: emoji('🌀') },
  price: { bg: 'bg-[linear-gradient(135deg,#e08a9a,#7a2f45_55%,#240c14)]', ring: 'ring-[#f2a4b3]', art: emoji('🎤') },
};

export const ART: Record<string, Record<string, Art>> = {
  theme: {
    hidden_king: {
      bg: 'bg-[linear-gradient(135deg,#f7bb5c,#c97c22_55%,#3a250f)]',
      ring: 'ring-[#f0a24a]',
      art: icon('/icons/objectives/patron-0.webp'),
      note: 'Amber Hand',
    },
    archmother: {
      bg: 'bg-[linear-gradient(135deg,#84a8ff,#3a68df_55%,#0c1a45)]',
      ring: 'ring-[#5b8cff]',
      art: icon('/icons/objectives/patron-1.webp'),
      note: 'Sapphire Flame',
    },
    deadlock: {
      bg: 'bg-[linear-gradient(135deg,#d9f891,#5f7a3a_55%,#171c18)]',
      ring: 'ring-[#d9f891]',
      art: icon('/images/deadlock-icon.webp', true),
      note: 'Sewer green',
    },
    christmas: {
      bg: 'bg-[linear-gradient(135deg,#f08a90,#b8323c_50%,#14302a)]',
      ring: 'ring-[#ec7c84]',
      art: emoji('🎄'),
      note: 'Holly red, with snow',
    },
  },
  slot_icons: {
    deadlock: {
      bg: 'bg-ink-800',
      ring: 'ring-gold-400',
      art: () => (
        <span class="flex gap-0.5">
          <For each={['items/extended-magazine', 'items/extra-health', 'objectives/walker']}>
            {(src) => <img src={`/icons/${src}.webp`} alt="" class="size-6 rounded" />}
          </For>
        </span>
      ),
      note: 'Shop items & objectives',
    },
    classic: {
      bg: 'bg-ink-800',
      ring: 'ring-gold-400',
      art: () => <span class="text-xl leading-none">🍒🍋💎</span>,
      note: 'Fruit machine',
    },
  },
  music_pack: Object.fromEntries(MUSIC_PACKS.map((p) => [p.id, { ...PACK_ART[p.id]!, note: p.note }])),
  sfx_pack: {
    deadlock: {
      bg: 'bg-[linear-gradient(135deg,#d9f891,#5f7a3a_55%,#171c18)]',
      ring: 'ring-[#d9f891]',
      art: icon('/images/deadlock-icon.webp', true),
      note: 'Brass, clockwork, game stingers',
    },
    arcade: { bg: 'bg-[linear-gradient(135deg,#ff8ad8,#7a3cff_55%,#1a1030)]', ring: 'ring-[#ff8ad8]', art: emoji('🎰'), note: 'Bright chimes and coins' },
    soft: { bg: 'bg-[linear-gradient(135deg,#b9d6e8,#5b7d99_55%,#1b2530)]', ring: 'ring-[#b9d6e8]', art: emoji('🔔'), note: 'Quiet, gentle clicks' },
    christmas: { bg: 'bg-[linear-gradient(135deg,#f08a90,#b8323c_50%,#14302a)]', ring: 'ring-[#ec7c84]', art: emoji('🛷'), note: 'Sleigh bells and carols' },
  },
};

/** A version of a music pack wears its pack's tile, with the pack's name as the note. */
export function artOf(key: string, id: string): Art | undefined {
  const own = ART[key]?.[id];
  if (own) return own;
  const pack = packOfExperiment(key);
  const art = pack ? ART.music_pack?.[pack] : undefined;
  return art && { ...art, note: musicPack(pack!)?.title ?? '' };
}
