
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import React, { useState, useRef } from 'react';
import { GoogleGenerativeAI } from '@google/generative-ai';
import jsPDF from 'jspdf';
import { MAX_STORY_PAGES, BACK_COVER_PAGE, TOTAL_PAGES, INITIAL_PAGES, BATCH_SIZE, DECISION_PAGES, GENRES, ART_STYLES, TONES, LANGUAGES, ComicFace, Beat, Persona } from './types';
import { Setup } from './Setup';
import { Book } from './Book';
import { useApiKey } from './useApiKey';
import { ApiKeyDialog } from './ApiKeyDialog';
import { supabase } from './supabaseClient';
import { Session } from '@supabase/supabase-js';

// --- Constants ---
const STORY_MODEL = "llama3-70b-8192";
const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";

const STORY_FALLBACK: Beat[] = [
    { panels: [{ scene: "Hero awakens", caption: "The awakening.", focus_char: 'hero' }], choices: [] },
    { panels: [{ scene: "Villain appears", caption: "A threat emerges.", focus_char: 'friend' }], choices: [] },
    { panels: [{ scene: "Battle", caption: "Steel met steel.", focus_char: 'hero' }], choices: [] },
    { panels: [{ scene: "Struggle", caption: "Pushed to the limit.", focus_char: 'hero' }], choices: [] },
    { panels: [{ scene: "Victory", caption: "POW!", focus_char: 'hero' }], choices: [] }
];

const BASE_STYLE = "Masterpiece anime manga style, high contrast ink, detailed cinematic lighting, speed lines, dramatic shadows";
const FALLBACK_IMAGE_SVG = "data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='768' height='768' viewBox='0 0 768 768'%3E%3Crect width='100%25' height='100%25' fill='%23222222'/%3E%3Ctext x='50%25' y='50%25' font-family='Arial' font-size='40' font-weight='bold' fill='%23ff5555' dominant-baseline='middle' text-anchor='middle'%3EIMAGE FAILED%3C/text%3E%3C/svg%3E";

// --- Ironclad Pipeline Utilities ---
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
const imageCache = new Map<string, string>();
const breaker = { pollinationsBlockedUntil: 0 };
let inFlightCount = 0;
const MAX_CONCURRENT = 2;

function sanitizePrompt(raw: string) {
  return raw
    .replace(/\s+/g, " ")
    .replace(/,\s*,/g, ',') // Kill double commas or weird spacing
    .replace(/[^a-zA-Z0-9 ,.-]/g, " ")
    .trim()
    .slice(0, 200);
}

async function withTimeout<T>(p: Promise<T>, ms = 12000): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))
  ]);
}

const App: React.FC = () => {
  // --- Generation State ---
  const [isGenerating, setIsGenerating] = useState(false);
  const [dailyCount, setDailyCount] = useState(0);
  const MAX_DAILY = 5;
  // --- Auth State ---
  const [session, setSession] = useState<Session | null>(null);

  React.useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });

    return () => subscription.unsubscribe();
  }, []);

  // --- API Key Hook ---
  const { validateApiKey, setShowApiKeyDialog, showApiKeyDialog, handleApiKeyDialogContinue } = useApiKey();

  const [hero, setHeroState] = useState<Persona | null>(null);
  const [friend, setFriendState] = useState<Persona | null>(null);
  const [selectedGenre, setSelectedGenre] = useState(GENRES[0]);
  const [selectedStyle, setSelectedStyle] = useState(ART_STYLES[0]);
  const [selectedLanguage, setSelectedLanguage] = useState(LANGUAGES[0].code);
  const [customPremise, setCustomPremise] = useState("");
  const [storyTone, setStoryTone] = useState(TONES[0]);
  const [richMode, setRichMode] = useState(true);
  
  const heroRef = useRef<Persona | null>(null);
  const friendRef = useRef<Persona | null>(null);

  const setHero = (p: Persona | null) => { setHeroState(p); heroRef.current = p; };
  const setFriend = (p: Persona | null) => { setFriendState(p); friendRef.current = p; };
  
  const [comicFaces, setComicFaces] = useState<ComicFace[]>([]);
  const [currentSheetIndex, setCurrentSheetIndex] = useState(0);
  const [isStarted, setIsStarted] = useState(false);
  
  // --- Transition States ---
  const [showSetup, setShowSetup] = useState(true);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [genProgress, setGenProgress] = useState({ current: 0, total: TOTAL_PAGES });

  const generatingPages = useRef(new Set<number>());
  const historyRef = useRef<ComicFace[]>([]);

  // --- AI Helpers ---
  // Helper to always get a fresh instance with the selected key
  const getAI = () => {
    const key = import.meta.env.VITE_GEMINI_API_KEY || (window as any).aistudio?.getSelectedApiKey?.();
    // Force v1 for stability across all regions
    return new GoogleGenerativeAI(key);
  };

  const handleAPIError = (e: any) => {
    const msg = String(e);
    console.error("API Error:", msg);
    if (
      msg.includes('Requested entity was not found') || 
      msg.includes('API_KEY_INVALID') || 
      msg.toLowerCase().includes('permission denied')
    ) {
      setShowApiKeyDialog(true);
    }
  };

  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve((reader.result as string).split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  };

  const runGroq = async (prompt: string) => {
      const key = import.meta.env.VITE_GROQ_API_KEY;
      if (!key) throw new Error("GROQ_API_KEY_MISSING");
      
      const response = await fetch(GROQ_API_URL, {
          method: 'POST',
          headers: {
              'Authorization': `Bearer ${key}`,
              'Content-Type': 'application/json'
          },
          body: JSON.stringify({
              model: STORY_MODEL,
              messages: [{ 
                  role: 'system', 
                  content: 'You are a professional comic book script writer. Output strictly valid JSON objects.' 
              }, { 
                  role: 'user', 
                  content: prompt 
              }],
              temperature: 0.7,
              response_format: { type: 'json_object' }
          })
      });

      if (!response.ok) throw new Error(`Groq API Error: ${response.status}`);
      const data = await response.json();
      return data.choices[0].message.content;
  };

  // Phase 3 now uses generateFullStory exclusively

  /**
   * Generates the ENTIRE story in one single API call (Phase 3)
   */
  const generateFullStory = async (userPrompt: string): Promise<Beat[]> => {
      const prompt = `
Generate a 5-page comic book story: "${userPrompt}".
Each page MUST have exactly 4 panels.
Return JSON:
{
  "pages": [
    {
      "panels": [
        {
          "scene": "Visual description (English)",
          "caption": "Narrative box text (Target language)",
          "dialogue": "Short speech (Target language)",
          "sfx": "Sound effect (e.g. KRKA-DOOM!)",
          "camera": "close-up | medium | wide",
          "mood": "dark | intense | calm",
          "focus_char": "hero | friend | other"
        }
      ],
      "choices": []
    }
  ]
}
Output ONLY JSON.
`;
      try {
          const rawText = await runGroq(prompt);
          const data = JSON.parse(rawText);
          const pages = data.pages || data;
          return Array.isArray(pages) ? pages.slice(0, 5) : STORY_FALLBACK;
      } catch (e) {
          console.warn("Full story gen failed, using fallback", e);
          return STORY_FALLBACK;
      }
  };

  /**
   * Generates a character persona (base64 image and description) based on a text prompt.
   * @param desc The description of the persona to generate.
   * @returns A promise that resolves to a Persona object.
   */
  const generatePersona = async (desc: string): Promise<Persona> => {
      const seed = Math.floor(Math.random() * 1000000);
      const style = selectedGenre === 'Custom' ? "Modern American comic book art" : `${selectedGenre} comic`;
      const prompt = encodeURIComponent(`Masterpiece anime character sheet, ${style}, detailed, full body, ${desc}`);
      const imageUrl = `https://image.pollinations.ai/prompt/${prompt}?seed=${seed}&width=512&height=512&nologo=true`;
      
      // Zero-Error Fix: Don't fetch, use the URL as the "base64" (it's a string, it works)
      return { base64: imageUrl, desc };
  };

  const loadSecureImage = async (rawUrl: string): Promise<HTMLImageElement> => {
    const proxies = [
        `https://corsproxy.io/?${encodeURIComponent(rawUrl)}`,
        `https://api.allorigins.win/raw?url=${encodeURIComponent(rawUrl)}`
    ];

    for (const proxyUrl of proxies) {
        try {
            const response = await fetch(proxyUrl);
            if (!response.ok) continue;
            
            const blob = await response.blob();
            const localUrl = URL.createObjectURL(blob);
            
            return await new Promise((resolve, reject) => {
                const img = new Image();
                img.onload = () => {
                    resolve(img);
                    URL.revokeObjectURL(localUrl);
                };
                img.onerror = () => reject(new Error("Decode failed"));
                img.src = localUrl;
            });
        } catch (e) {
            console.warn(`Proxy failed: ${proxyUrl}`, e);
        }
    }

    console.error("All proxies failed. Returning fallback.");
    const fallback = new Image();
    fallback.src = FALLBACK_IMAGE_SVG;
    return new Promise(resolve => { fallback.onload = () => resolve(fallback); });
  };

  const generateImage = async (panel: Panel): Promise<string> => {
    const heroDesc = heroRef.current?.desc || "anime hero warrior";
    const costarDesc = friendRef.current?.desc || "anime sidekick ally";
    const charAnchor = panel.focus_char === 'hero' ? heroDesc : (panel.focus_char === 'friend' ? costarDesc : "");
    
    const segments = [BASE_STYLE, panel.camera || "medium shot", panel.mood || "intense mood", charAnchor, panel.scene];
    const rawPrompt = segments.filter(s => s && s.trim()).join(", ");
    const prompt = sanitizePrompt(rawPrompt);
    const key = prompt.toLowerCase();

    if (imageCache.has(key)) return imageCache.get(key)!;

    const seed = Math.floor(Math.random() * 1000000);
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?seed=${seed}&width=768&height=768&nologo=true`;
    
    imageCache.set(key, url);
    return url;
  };

  const composePage = async (beat: Beat): Promise<string> => {
      const canvas = document.createElement('canvas');
      canvas.width = 1024;
      canvas.height = 1536;
      const ctx = canvas.getContext('2d');
      if (!ctx) return '';

      const panels = beat.panels.slice(0, 4);
      const panelImages = [];

      for (let i = 0; i < panels.length; i++) {
          const url = await generateImage(panels[i]);
          const img = await loadSecureImage(url);
          panelImages.push(img);
          await delay(800);
      }

      const w = canvas.width;
      const h = canvas.height;
      const positions = [[0, 0], [w/2, 0], [0, h/2], [w/2, h/2]];

      panelImages.forEach((img, i) => {
          const [x, y] = positions[i];
          const panel = panels[i];
          
          // Draw Image
          ctx.drawImage(img, x, y, w/2, h/2);
          
          // Panel Border
          ctx.strokeStyle = "black";
          ctx.lineWidth = 10;
          ctx.strokeRect(x, y, w/2, h/2);

          // 1. Caption (Top Yellow Box)
          if (panel.caption) {
              ctx.fillStyle = "rgba(255, 255, 0, 0.9)";
              ctx.fillRect(x + 10, y + 10, w/2 - 20, 40);
              ctx.strokeStyle = "black";
              ctx.lineWidth = 2;
              ctx.strokeRect(x + 10, y + 10, w/2 - 20, 40);
              ctx.fillStyle = "black";
              ctx.font = "bold 16px 'Comic Neue'";
              ctx.fillText(panel.caption.slice(0, 40), x + 20, y + 35);
          }

          // 2. Dialogue (White Bubble)
          if (panel.dialogue) {
              ctx.fillStyle = "white";
              ctx.fillRect(x + 30, y + h/4, w/2 - 60, 60);
              ctx.strokeStyle = "black";
              ctx.strokeRect(x + 30, y + h/4, w/2 - 60, 60);
              ctx.fillStyle = "black";
              ctx.font = "bold 18px Arial";
              ctx.fillText(panel.dialogue.slice(0, 35), x + 40, y + h/4 + 35);
          }

          // 3. SFX (Bold Comic Text)
          if (panel.sfx) {
              ctx.fillStyle = "red";
              ctx.font = "bold 50px Bangers";
              ctx.shadowColor = "yellow";
              ctx.shadowBlur = 10;
              ctx.fillText(panel.sfx, x + 50, y + h/2 - 50);
              ctx.shadowBlur = 0; // reset
          }
      });

      return canvas.toDataURL("image/jpeg", 0.9);
  };

  const updateFaceState = (id: string, updates: Partial<ComicFace>) => {
      setComicFaces(prev => {
          const newFaces = prev.map(f => f.id === id ? { ...f, ...updates } : f);
          // Sync with historyRef immediately for persistence
          const idx = historyRef.current.findIndex(f => f.id === id);
          if (idx !== -1) historyRef.current[idx] = { ...historyRef.current[idx], ...updates };
          return newFaces;
      });
  };

  const generateSinglePage = async (faceId: string, pageNum: number, type: ComicFace['type'], providedBeat?: Beat) => {
      const isDecision = DECISION_PAGES.includes(pageNum);
      let beat: Beat = providedBeat || { panels: [{ scene: "A mysterious scene", focus_char: 'other' }], choices: [] };

      updateFaceState(faceId, { narrative: beat, choices: beat.choices, isDecisionPage: isDecision, isLoading: true });
      const url = await composePage(beat);
      updateFaceState(faceId, { imageUrl: url, isLoading: false });
  };

  const generateBatch = async (startPage: number, count: number, preGeneratedBeats?: Beat[]) => {
      if (isGenerating) return;
      setIsGenerating(true);

      const pagesToGen: number[] = [];
      for (let i = 0; i < count; i++) {
          const p = startPage + i;
          if (p <= TOTAL_PAGES && !generatingPages.current.has(p)) {
              pagesToGen.push(p);
          }
      }
      
      if (pagesToGen.length === 0) { setIsGenerating(false); return; }
      pagesToGen.forEach(p => generatingPages.current.add(p));

      // Phase 5: Check limits
      if (dailyCount >= MAX_DAILY) {
          alert("You've reached the free daily limit (5 comics). Come back tomorrow!");
          setIsGenerating(false);
          return;
      }

      try {
          // Phase 1: Sequential Pipeline
          for (let i = 0; i < pagesToGen.length; i++) {
              const pageNum = pagesToGen[i];
              const type = pageNum === BACK_COVER_PAGE ? 'back_cover' : (pageNum === 1 ? 'cover' : 'story');
              
              // Add face to state if it doesn't exist
              setComicFaces(prev => {
                  if (prev.find(f => f.id === `page-${pageNum}`)) return prev;
                  return [...prev, { id: `page-${pageNum}`, type, choices: [], isLoading: true, pageIndex: pageNum }];
              });

              // Apply pre-generated beat or fallback (Fix: Mapping beat index correctly)
              if (preGeneratedBeats) {
                  const beatIdx = pageNum - 1; // Page 1 gets beat 0, Page 2 gets beat 1...
                  const beat = preGeneratedBeats[beatIdx] || STORY_FALLBACK[beatIdx % STORY_FALLBACK.length];
                  updateFaceState(`page-${pageNum}`, { narrative: beat });
                  
                  // Generate the image using this beat
                  await generateSinglePage(`page-${pageNum}`, pageNum, type, beat);
              } else {
                  await generateSinglePage(`page-${pageNum}`, pageNum, type);
              }
              await new Promise(r => setTimeout(r, 2000));
              
              setGenProgress(prev => ({ ...prev, current: prev.current + 1 }));
          }
          
          setDailyCount(prev => prev + 1);
          if (pagesToGen.includes(BACK_COVER_PAGE)) {
              saveComicToDatabase(historyRef.current);
          }
      } catch (e) {
          console.error("Batch generation error", e);
      } finally {
          setIsGenerating(false);
          pagesToGen.forEach(p => generatingPages.current.delete(p));
      }
  };


  const launchStory = async () => {
    // --- API KEY VALIDATION ---
    const hasKey = await validateApiKey();
    if (!hasKey) return; // Stop if cancelled or invalid
    
    if (!heroRef.current) return;
    if (selectedGenre === 'Custom' && !customPremise.trim()) {
        alert("Please enter a custom story premise.");
        return;
    }
    setIsTransitioning(true);
    
    let availableTones = TONES;
    if (selectedGenre === "Teen Drama / Slice of Life" || selectedGenre === "Lighthearted Comedy") {
        availableTones = TONES.filter(t => t.includes("CASUAL") || t.includes("WHOLESOME") || t.includes("QUIPPY"));
    } else if (selectedGenre === "Classic Horror") {
        availableTones = TONES.filter(t => t.includes("INNER-MONOLOGUE") || t.includes("OPERATIC"));
    }
    
    setStoryTone(availableTones[Math.floor(Math.random() * availableTones.length)]);

    const coverFace: ComicFace = { id: 'cover', type: 'cover', choices: [], isLoading: true, pageIndex: 0 };
    setComicFaces([coverFace]);
    historyRef.current = [coverFace];
    generatingPages.current.add(0);

    generateSinglePage('cover', 0, 'cover').finally(() => generatingPages.current.delete(0));
    
    setTimeout(async () => {
        setIsStarted(true);
        setShowSetup(false);
        setIsTransitioning(false);
        await generateBatch(1, INITIAL_PAGES);
        generateBatch(3, 3);
    }, 1100);
  };

  const saveComicToDatabase = async (finalFaces: ComicFace[]) => {
      if (!session?.user?.id) return;

      const title = `The Adventures of ${heroRef.current?.desc || 'Hero'}`;
      
      const { error } = await supabase.from('comics').insert([{
          user_id: session.user.id,
          title: title,
          genre: selectedGenre,
          language: selectedLanguage,
          pages: finalFaces.map(f => ({
              id: f.id,
              type: f.type,
              imageUrl: f.imageUrl,
              caption: f.narrative?.caption,
              dialogue: f.narrative?.dialogue,
              choice: f.resolvedChoice
          }))
      }]);

      if (error) {
          console.error("Error saving comic:", error.message);
      } else {
          console.log("Comic saved successfully to library!");
      }
  };

  const handleChoice = async (pageIndex: number, choice: string) => {
      updateFaceState(`page-${pageIndex}`, { resolvedChoice: choice });
      const maxPage = Math.max(...historyRef.current.map(f => f.pageIndex || 0));
      if (maxPage + 1 <= TOTAL_PAGES) {
          generateBatch(maxPage + 1, BATCH_SIZE);
      }
  }

  const resetApp = () => {
      setIsStarted(false);
      setShowSetup(true);
      setComicFaces([]);
      setCurrentSheetIndex(0);
      historyRef.current = [];
      generatingPages.current.clear();
      setHero(null);
      setFriend(null);
  };

  const downloadPDF = () => {
    const PAGE_WIDTH = 480;
    const PAGE_HEIGHT = 720;
    const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: [PAGE_WIDTH, PAGE_HEIGHT] });
    const pagesToPrint = comicFaces.filter(face => face.imageUrl && !face.isLoading).sort((a, b) => (a.pageIndex || 0) - (b.pageIndex || 0));

    pagesToPrint.forEach((face, index) => {
        if (index > 0) doc.addPage([PAGE_WIDTH, PAGE_HEIGHT], 'portrait');
        if (face.imageUrl) doc.addImage(face.imageUrl, 'JPEG', 0, 0, PAGE_WIDTH, PAGE_HEIGHT);
    });
    doc.save('Infinite-Heroes-Issue.pdf');
  };

  const handleHeroUpload = async (input: File | string) => {
       try { 
           if (typeof input === 'string') {
               const res = await fetch(input);
               const blob = await res.blob();
               const base64 = await fileToBase64(new File([blob], 'hero.png', { type: 'image/png' }));
               setHero({ base64, desc: "The Main Hero" });
           } else {
               const base64 = await fileToBase64(input); 
               setHero({ base64, desc: "The Main Hero" }); 
           }
       } catch (e) { alert("Hero selection failed"); }
  };
  const handleFriendUpload = async (input: File | string) => {
       try { 
           if (typeof input === 'string') {
               const res = await fetch(input);
               const blob = await res.blob();
               const base64 = await fileToBase64(new File([blob], 'friend.png', { type: 'image/png' }));
               setFriend({ base64, desc: "The Sidekick/Rival" });
           } else {
               const base64 = await fileToBase64(input); 
               setFriend({ base64, desc: "The Sidekick/Rival" }); 
           }
       } catch (e) { alert("Friend selection failed"); }
  };

  const handleSheetClick = (index: number) => {
      if (!isStarted) return;
      if (index === 0 && currentSheetIndex === 0) return;
      if (index < currentSheetIndex) setCurrentSheetIndex(index);
      else if (index === currentSheetIndex && comicFaces.find(f => f.pageIndex === index)?.imageUrl) setCurrentSheetIndex(prev => prev + 1);
  };

  // --- Authentication Gate ---
  if (!session) {
    return (
      <div className="fixed inset-0 z-[500] flex items-center justify-center bg-slate-900 overflow-hidden">
        {/* Animated Background */}
        <div className="absolute inset-0 opacity-20 pointer-events-none">
          <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-blue-500 rounded-full blur-[120px] animate-pulse"></div>
          <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-red-500 rounded-full blur-[120px] animate-pulse delay-700"></div>
        </div>

        <div className="relative max-w-md w-full bg-white border-[6px] border-black shadow-[16px_16px_0px_rgba(0,0,0,1)] p-10 text-center rotate-1">
          <div className="absolute -top-12 -left-12 w-24 h-24 bg-yellow-400 rounded-full flex items-center justify-center border-4 border-black shadow-[4px_4px_0px_rgba(0,0,0,1)] animate-bounce">
             <span className="text-5xl">⚡</span>
          </div>

          <h1 className="font-comic text-6xl text-red-600 mb-2 uppercase tracking-tighter" style={{textShadow: '3px 3px 0px black'}}>
            Infinite Heroes
          </h1>
          <p className="font-comic text-2xl text-black mb-8 leading-tight">
            The Multiverse is <span className="text-blue-600">Locked!</span> <br/>
            Sign in to start your adventure.
          </p>

          <button 
            onClick={() => supabase.auth.signInWithOAuth({ provider: 'google' })}
            className="comic-btn bg-white text-black text-2xl px-8 py-4 w-full flex items-center justify-center gap-4 hover:bg-gray-100 transition-all active:scale-95 border-4 border-black shadow-[8px_8px_0px_rgba(0,0,0,1)]"
          >
            <img src="https://www.google.com/favicon.ico" className="w-8 h-8" alt="Google" />
            <span className="font-bold">SIGN IN WITH GOOGLE</span>
          </button>

          <p className="mt-8 text-xs text-gray-400 font-mono uppercase tracking-widest">
            Identity verification required by the council of heroes
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="comic-scene">
      {showApiKeyDialog && <ApiKeyDialog onContinue={handleApiKeyDialogContinue} />}
      
      <Setup 
          show={showSetup}
          isTransitioning={isTransitioning}
          hero={hero}
          friend={friend}
          selectedGenre={selectedGenre}
          selectedStyle={selectedStyle}
          selectedLanguage={selectedLanguage}
          customPremise={customPremise}
          richMode={richMode}
          onHeroUpload={handleHeroUpload}
          onFriendUpload={handleFriendUpload}
          onGenreChange={setSelectedGenre}
          onStyleChange={setSelectedStyle}
          onLanguageChange={setSelectedLanguage}
          onPremiseChange={setCustomPremise}
          onRichModeChange={setRichMode}
          onLaunch={launchStory}
          session={session}
          progress={genProgress}
      />
      
      <Book 
          comicFaces={comicFaces}
          currentSheetIndex={currentSheetIndex}
          isStarted={isStarted}
          isSetupVisible={showSetup && !isTransitioning}
          onSheetClick={handleSheetClick}
          onChoice={handleChoice}
          onOpenBook={() => setCurrentSheetIndex(1)}
          onDownload={downloadPDF}
          onReset={resetApp}
      />
    </div>
  );
};

export default App;
