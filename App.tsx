
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

const STORY_FALLBACK = [
    { scene: "Hero awakens mysterious power in a dark neon city", caption: "The transformation was sudden. The city's neon lights pulsed in sync with my heartbeat.", dialogue: "What... what is this power?", focus_char: "hero" },
    { scene: "A mysterious villain in shadows appears and challenges the hero", caption: "From the darkness, a voice spoke. The rival had found me.", dialogue: "You think you're ready? You've barely scratched the surface.", focus_char: "friend" },
    { scene: "An intense battle begins in a rainy alleyway", caption: "Steel met steel in the rain. Every move felt like instinct.", dialogue: "I won't let you destroy this city!", focus_char: "hero" },
    { scene: "Hero struggles but finds new resolve", caption: "I was pushed to the limit. But then, I remembered why I started this.", dialogue: "I'm not finished yet!", focus_char: "hero" },
    { scene: "Climactic final attack with a burst of light", caption: "One final strike. One chance to end it all.", dialogue: "POW!", focus_char: "hero" }
];

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
Generate a 5-page comic book story based on: "${userPrompt}".
Return a JSON object with a key "beats" containing exactly 5 objects. Each object MUST have:
{
  "scene": "Visual description of the action (Short & Punchy)",
  "caption": "Narrative text for the box",
  "dialogue": "Character speech bubble text (Keep it short)",
  "focus_char": "hero" or "friend" or "other"
}
Output ONLY the JSON. No extra text.
`;
      try {
          const rawText = await runGroq(prompt);
          const data = JSON.parse(rawText);
          const beats = data.beats || data;
          return Array.isArray(beats) ? beats.slice(0, 5) : STORY_FALLBACK;
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

  const generateImage = async (beat: Beat, type: ComicFace['type']): Promise<string> => {
    const contents = [];
    if (heroRef.current?.base64) {
        contents.push({ text: "REFERENCE 1 [HERO]:" });
        contents.push({ inlineData: { mimeType: 'image/jpeg', data: heroRef.current.base64 } });
    }
    if (friendRef.current?.base64) {
        contents.push({ text: "REFERENCE 2 [CO-STAR]:" });
        contents.push({ inlineData: { mimeType: 'image/jpeg', data: friendRef.current.base64 } });
    }

    // Stable Seed for consistency
    const seed = (session?.user?.id?.split('').reduce((a, b) => a + b.charCodeAt(0), 0) || 12345) % 1000000;
    const heroDesc = heroRef.current?.desc || "anime hero";
    const costarDesc = friendRef.current?.desc || "anime sidekick";
    
    const styleEra = encodeURIComponent(selectedStyle);
    let sceneDesc = beat.scene;
    
    if (type === 'cover') {
        sceneDesc = `Comic Book Cover with title INFINITE HEROES, ${heroDesc} in action pose`;
    } else if (type === 'back_cover') {
        sceneDesc = `Comic Back Cover, dramatic teaser, ${heroDesc} looking at horizon`;
    } else {
        sceneDesc = `${beat.focus_char === 'hero' ? heroDesc : costarDesc}, ${beat.scene}`;
    }

    // Phase 4: Extreme Simplification (Match the success of the Cover image)
    const cleanScene = sceneDesc.replace(/[^a-zA-Z0-9 ]/g, " ").slice(0, 100);
    const scenePrompt = encodeURIComponent(`Masterpiece anime art ${cleanScene} high quality`);
    const imageUrl = `https://image.pollinations.ai/prompt/${scenePrompt}?seed=${seed}&width=768&height=1024&nologo=true`;

    return imageUrl;
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
      let beat: Beat = providedBeat || { scene: "A mysterious scene", choices: [], focus_char: 'other' };

      updateFaceState(faceId, { narrative: beat, choices: beat.choices, isDecisionPage: isDecision, isLoading: true });
      const url = await generateImage(beat, type);
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
