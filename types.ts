/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

export const MAX_STORY_PAGES = 6;
export const BACK_COVER_PAGE = 7;
export const TOTAL_PAGES = 7;
export const INITIAL_PAGES = 2;
export const GATE_PAGE = 2;
export const BATCH_SIZE = 4;
export const DECISION_PAGES = [3];

export const GENRES = ["Classic Horror", "Superhero Action", "Dark Sci-Fi", "High Fantasy", "Neon Noir Detective", "Wasteland Apocalypse", "Lighthearted Comedy", "Teen Drama / Slice of Life", "Custom"];
export const TONES = [
    "ACTION-HEAVY (Short, punchy dialogue. Focus on kinetics.)",
    "INNER-MONOLOGUE (Heavy captions revealing thoughts.)",
    "QUIPPY (Characters use humor as a defense mechanism.)",
    "OPERATIC (Grand, dramatic declarations and high stakes.)",
    "CASUAL (Natural dialogue, focus on relationships/gossip.)",
    "WHOLESOME (Warm, gentle, optimistic.)"
];

export const LANGUAGES = [
    { code: 'en-US', name: 'English (US)' },
    { code: 'ar-EG', name: 'Arabic (Egypt)' },
    { code: 'de-DE', name: 'German (Germany)' },
    { code: 'es-MX', name: 'Spanish (Mexico)' },
    { code: 'fr-FR', name: 'French (France)' },
    { code: 'hi-IN', name: 'Hindi (India)' },
    { code: 'id-ID', name: 'Indonesian (Indonesia)' },
    { code: 'it-IT', name: 'Italian (Italy)' },
    { code: 'ja-JP', name: 'Japanese (Japan)' },
    { code: 'ko-KR', name: 'Korean (South Korea)' },
    { code: 'pt-BR', name: 'Portuguese (Brazil)' },
    { code: 'ru-RU', name: 'Russian (Russia)' },
    { code: 'ua-UA', name: 'Ukrainian (Ukraine)' },
    { code: 'vi-VN', name: 'Vietnamese (Vietnam)' },
    { code: 'zh-CN', name: 'Chinese (China)' }
];

export const ART_STYLES = [
    "Classic Manga",
    "Modern American",
    "Cyberpunk Neon",
    "Watercolor Fantasy",
    "Film Noir (B&W)",
    "Oil Painting",
    "Sketchbook"
];

export const DEFAULT_HEROES = [
    { name: "Samurai", path: "/defaults/hero_1.png", desc: "A cool samurai warrior with a blue glowing sword." },
    { name: "Cyber", path: "/defaults/hero_2.png", desc: "A futuristic cybernetic girl with neon accents." },
    { name: "Knight", path: "/defaults/hero_3.png", desc: "A heroic knight in golden armor." },
    { name: "Mage", path: "/defaults/hero_4.png", desc: "A mysterious mage with purple magical energy." },
    { name: "Pilot", path: "/defaults/hero_5.png", desc: "A charismatic mecha pilot in a flight suit." }
];

export const DEFAULT_COSTARS = [
    { name: "Thief", path: "/defaults/costar_1.png", desc: "An agile ninja thief with daggers." },
    { name: "Robot", path: "/defaults/costar_2.png", desc: "A friendly helper robot with digital eyes." },
    { name: "Elf", path: "/defaults/costar_3.png", desc: "An elegant elf archer with a wooden bow." },
    { name: "Rival", path: "/defaults/costar_4.png", desc: "An edgy rival character in a leather jacket." },
    { name: "Spirit", path: "/defaults/costar_5.png", desc: "An ethereal fox spirit with glowing trails." }
];

export interface ComicFace {
  id: string;
  type: 'cover' | 'story' | 'back_cover';
  imageUrl?: string;
  narrative?: Beat;
  choices: string[];
  resolvedChoice?: string;
  isLoading: boolean;
  pageIndex?: number;
  isDecisionPage?: boolean;
}

export interface Panel {
  scene: string;
  caption?: string;
  dialogue?: string;
  sfx?: string;
  camera?: string;
  mood?: string;
  focus_char: 'hero' | 'friend' | 'other';
}

export interface Beat {
  panels: Panel[];
  choices: string[];
}

export interface Persona {
  base64: string;
  desc: string;
}