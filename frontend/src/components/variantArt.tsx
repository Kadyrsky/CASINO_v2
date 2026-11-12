/** What each experiment's options look like on a tile, so people can tell them apart before trying them. */
import { For, type JSX } from 'solid-js';
import { STATIONS } from '../lib/musicCatalog';

export interface Art {
  bg: string;
  ring: string;
  art: () => JSX.Element;
  note: string;
}

const emoji = (e: string) => () => <span class="text-2xl leading-none drop-shadow-[0_2px_4px_rgb(0_0_0/0.5)]">{e}</span>;

export const ART: Record<string, Record<string, Art>> = {
  theme: {
    hidden_king: {
      bg: 'bg-[linear-gradient(135deg,#f7bb5c,#c97c22_55%,#3a250f)]',
      ring: 'ring-[#f0a24a]',
      art: () => <img src="/icons/objectives/patron-0.webp" alt="" class="size-9 drop-shadow-[0_2px_4px_rgb(0_0_0/0.6)]" />,
      note: 'Amber Hand',
    },
    archmother: {
      bg: 'bg-[linear-gradient(135deg,#84a8ff,#3a68df_55%,#0c1a45)]',
      ring: 'ring-[#5b8cff]',
      art: () => <img src="/icons/objectives/patron-1.webp" alt="" class="size-9 drop-shadow-[0_2px_4px_rgb(0_0_0/0.6)]" />,
      note: 'Sapphire Flame',
    },
    deadlock: {
      bg: 'bg-[linear-gradient(135deg,#d9f891,#5f7a3a_55%,#171c18)]',
      ring: 'ring-[#d9f891]',
      art: () => <img src="/images/deadlock-icon.webp" alt="" class="size-9 rounded-full" />,
      note: 'Sewer green',
    },
    classic: {
      bg: 'bg-[linear-gradient(135deg,#f3cd87,#c4862a_55%,#1d1a28)]',
      ring: 'ring-[#e2a443]',
      art: () => <span class="font-sans text-2xl font-black text-[#0b0a10]">N</span>,
      note: 'The old look',
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
  music: {
    lounge: { bg: 'bg-[linear-gradient(135deg,#a47243,#4a2f1a_55%,#1c130c)]', ring: 'ring-[#e0b070]', art: emoji('🎷'), note: STATIONS.lounge!.note },
    hideout: { bg: 'bg-[linear-gradient(135deg,#7f86d6,#363b78_55%,#121428)]', ring: 'ring-[#9aa2ff]', art: emoji('🎧'), note: STATIONS.hideout!.note },
    gothic: { bg: 'bg-[linear-gradient(135deg,#9a5b7e,#43233a_55%,#160c13)]', ring: 'ring-[#d68ab5]', art: emoji('🕯️'), note: STATIONS.gothic!.note },
    rift: {
      bg: 'bg-[linear-gradient(135deg,#5fb6d6,#25536a_55%,#0b1a22)]',
      ring: 'ring-[#7fd3f0]',
      art: () => <img src="/icons/objectives/rift.webp" alt="" class="size-9 drop-shadow-[0_2px_4px_rgb(0_0_0/0.6)]" />,
      note: STATIONS.rift!.note,
    },
  },
  sfx_pack: {
    deadlock: {
      bg: 'bg-[linear-gradient(135deg,#d9f891,#5f7a3a_55%,#171c18)]',
      ring: 'ring-[#d9f891]',
      art: () => <img src="/images/deadlock-icon.webp" alt="" class="size-9 rounded-full" />,
      note: 'Brass, clockwork, game stingers',
    },
    arcade: { bg: 'bg-[linear-gradient(135deg,#ff8ad8,#7a3cff_55%,#1a1030)]', ring: 'ring-[#ff8ad8]', art: emoji('🎰'), note: 'Bright chimes and coins' },
    soft: { bg: 'bg-[linear-gradient(135deg,#b9d6e8,#5b7d99_55%,#1b2530)]', ring: 'ring-[#b9d6e8]', art: emoji('🔔'), note: 'Quiet, gentle clicks' },
  },
};

export const artOf = (key: string, id: string): Art | undefined => ART[key]?.[id];
