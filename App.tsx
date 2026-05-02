
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
const STORY_MODEL = "models/gemini-1.5-flash-latest";

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

  const runGemini = async (method: (model: any) => Promise<any>) => {
      const ai = getAI();
      try {
          const model = ai.getGenerativeModel({ model: STORY_MODEL });
          return await method(model);
      } catch (e) {
          console.error(`Gemini Error:`, e);
          throw e;
      }
  };

  /**
   * Generates a story beat using the Gemini API.
   * @param history The previous pages' narrative data.
   * @param isRightPage Whether the current page is on the right side of the book.
   * @param pageNum The current page number.
   * @param isDecisionPage Whether this page should present a choice to the user.
   * @returns A promise that resolves to a Beat object.
   */
  const generateBeat = async (history: ComicFace[], isRightPage: boolean, pageNum: number, isDecisionPage: boolean): Promise<Beat> => {
    if (!heroRef.current) throw new Error("No Hero");

    const isFinalPage = pageNum === MAX_STORY_PAGES;
    const langName = LANGUAGES.find(l => l.code === selectedLanguage)?.name || "English";

    // Get relevant history and last focus to prevent repetition
    const relevantHistory = history
        .filter(p => p.type === 'story' && p.narrative && (p.pageIndex || 0) < pageNum)
        .sort((a, b) => (a.pageIndex || 0) - (b.pageIndex || 0));

    const lastBeat = relevantHistory[relevantHistory.length - 1]?.narrative;
    const lastFocus = lastBeat?.focus_char || 'none';

    const historyText = relevantHistory.map(p => 
      `[Page ${p.pageIndex}] [Focus: ${p.narrative?.focus_char}] (Caption: "${p.narrative?.caption || ''}") (Dialogue: "${p.narrative?.dialogue || ''}") (Scene: ${p.narrative?.scene}) ${p.resolvedChoice ? `-> USER CHOICE: "${p.resolvedChoice}"` : ''}`
    ).join('\n');

    // Aggressive Co-Star Injection Logic
    let friendInstruction = "Not yet introduced.";
    if (friendRef.current) {
        friendInstruction = "ACTIVE and PRESENT (User Provided).";
        // If the last panel wasn't the friend, strongly suggest switching to them to maintain balance.
        if (lastFocus !== 'friend' && Math.random() > 0.4) {
             friendInstruction += " MANDATORY: FOCUS ON THE CO-STAR FOR THIS PANEL.";
        } else {
             friendInstruction += " Ensure they are woven into the scene even if not the main focus.";
        }
    }

    // Determine Core Story Driver (Genre vs Custom Premise)
    let coreDriver = `GENRE: ${selectedGenre}. TONE: ${storyTone}.`;
    if (selectedGenre === 'Custom') {
        coreDriver = `STORY PREMISE: ${customPremise || "A totally unique, unpredictable adventure"}. (Follow this premise strictly over standard genre tropes).`;
    }
    
    const isSliceOfLife = selectedGenre.includes("Comedy") || selectedGenre.includes("Teen") || selectedGenre.includes("Slice");

    // Guardrails to prevent everything becoming "Quantum Sci-Fi"
    const guardrails = `
    NEGATIVE CONSTRAINTS:
    1. UNLESS GENRE IS "Dark Sci-Fi" OR "Superhero Action" OR "Custom": DO NOT use technical jargon like "Quantum", "Timeline", "Portal", "Multiverse", or "Singularity".
    2. IF GENRE IS "Teen Drama" OR "Lighthearted Comedy": The "stakes" must be SOCIAL, EMOTIONAL, or PERSONAL (e.g., a rumor, a competition, a broken promise, being late, embarrassing oneself). Do NOT make it life-or-death. Keep it grounded.
    3. Avoid "The artifact" or "The device" unless established earlier.
    `;

    // BASE INSTRUCTION: Strictly enforce language for output text.
    let instruction = `Continue the story in the style of a ${selectedStyle} comic. ALL OUTPUT TEXT (Captions, Dialogue, Choices) MUST BE IN ${langName.toUpperCase()}. ${coreDriver} ${guardrails}`;
    if (richMode) {
        instruction += " RICH/NOVEL MODE ENABLED. Prioritize deeper character thoughts, descriptive captions, and meaningful dialogue exchanges over short punchlines.";
    }

    if (isFinalPage) {
        instruction += " FINAL PAGE. KARMIC CLIFFHANGER REQUIRED. You MUST explicitly reference the User's choice from PAGE 3 in the narrative and show how that specific philosophy led to this conclusion. Text must end with 'TO BE CONTINUED...' (or localized equivalent).";
    } else if (isDecisionPage) {
        instruction += " End with a PSYCHOLOGICAL choice about VALUES, RELATIONSHIPS, or RISK. (e.g., Truth vs. Safety, Forgive vs. Avenge). The options must NOT be simple physical actions like 'Go Left'.";
    } else {
        // Neutralized Narrative Arc to avoid forcing "scary mystery" tones if the genre doesn't call for it.
        if (pageNum === 1) {
            instruction += " INCITING INCIDENT. An event disrupts the status quo. Establish the genre's intended mood. (If Slice of Life: A social snag/surprise. If Adventure: A call to action).";
        } else if (pageNum <= 4) {
            instruction += " RISING ACTION. The heroes engage with the new situation. Focus on dialogue, character dynamics, and initial challenges.";
        } else if (pageNum <= 8) {
            instruction += " COMPLICATION. A twist occurs! A secret is revealed, a misunderstanding deepens, or the path is blocked. (Keep intensity appropriate to Genre - e.g. Social awkwardness for Comedy, Danger for Horror).";
        } else {
            instruction += " CLIMAX. The confrontation with the main conflict. The truth comes out, the contest ends, or the battle is fought.";
        }
    }

    // Dynamic text limits based on richMode
    const capLimit = richMode ? "max 35 words. Detailed narration or internal monologue" : "max 15 words";
    const diaLimit = richMode ? "max 30 words. Rich, character-driven speech" : "max 12 words";

    const prompt = `
You are writing a comic book script. PAGE ${pageNum} of ${MAX_STORY_PAGES}.
TARGET LANGUAGE FOR TEXT: ${langName} (CRITICAL: CAPTIONS, DIALOGUE, CHOICES MUST BE IN THIS LANGUAGE).
${coreDriver}

CHARACTERS:
- HERO: Active.
- CO-STAR: ${friendInstruction}

PREVIOUS PANELS (READ CAREFULLY):
${historyText.length > 0 ? historyText : "Start the adventure."}

RULES:
1. NO REPETITION. Do not use the same captions or dialogue from previous pages.
2. IF CO-STAR IS ACTIVE, THEY MUST APPEAR FREQUENTLY.
3. VARIETY. If page ${pageNum-1} was an action shot, make this one a reaction or wide shot.
4. LANGUAGE: All user-facing text MUST be in ${langName}.
5. Avoid saying "CO-star" and "hero" in the text captions. Use names if established, or generic descriptors.

INSTRUCTION: ${instruction}

OUTPUT STRICT JSON ONLY (No markdown formatting):
{
  "caption": "Unique narrator text in ${langName}. (${capLimit}).",
  "dialogue": "Unique speech in ${langName}. (${diaLimit}). Optional.",
  "scene": "Vivid visual description (ALWAYS IN ENGLISH for the artist model). MUST mention 'HERO' or 'CO-STAR' if they are present.",
  "focus_char": "hero" OR "friend" OR "other",
  "choices": ["Option A in ${langName}", "Option B in ${langName}"] (Only if decision page)
}
`;
    try {
        const res = await runGemini((model) => 
            model.generateContent(prompt)
        );
        const response = await res.response;
        let rawText = response.text() || "{}";
        rawText = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
        
        const parsed = JSON.parse(rawText);
        // ... (validation)
        return parsed as Beat;
    } catch (e) {
        console.warn("Gemini failed, using fallback beat", e);
        const fallback = STORY_FALLBACK[pageNum - 1] || STORY_FALLBACK[0];
        return { 
            caption: fallback.caption, 
            scene: fallback.scene, 
            focus_char: fallback.focus_char as any, 
            choices: isDecisionPage ? ["Accept Fate", "Fight Back"] : [] 
        };
    }
};

  /**
   * Generates the ENTIRE story in one single API call (Phase 3)
   */
  const generateFullStory = async (userPrompt: string): Promise<Beat[]> => {
      const prompt = `
Generate a 5-page comic book story based on: "${userPrompt}".
Return a JSON array of exactly 5 objects. Each object MUST have:
{
  "scene": "Visual description of the action (Short & Punchy)",
  "caption": "Narrative text for the box",
  "dialogue": "Character speech bubble text (Keep it short)",
  "focus_char": "hero" or "friend" or "other"
}
Output ONLY the JSON array. No extra text.
`;
      try {
          const res = await runGemini(m => m.generateContent(prompt));
          const response = await res.response;
          let text = response.text().replace(/```json/g, '').replace(/```/g, '').trim();
          const beats = JSON.parse(text);
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

    const scenePrompt = encodeURIComponent(`Anime manga style, ${sceneDesc}, cinematic lighting, detailed ink`);
    const imageUrl = `https://image.pollinations.ai/prompt/${scenePrompt}?seed=${seed}&width=768&height=1024&nologo=true`;

    // Zero-Error Fix: Return URL directly. Browser <img> tags don't get 403'd like JS fetch() does.
    return imageUrl;
};

  const updateFaceState = (id: string, updates: Partial<ComicFace>) => {
      setComicFaces(prev => prev.map(f => f.id === id ? { ...f, ...updates } : f));
      const idx = historyRef.current.findIndex(f => f.id === id);
      if (idx !== -1) historyRef.current[idx] = { ...historyRef.current[idx], ...updates };
  };

  const generateSinglePage = async (faceId: string, pageNum: number, type: ComicFace['type']) => {
      const isDecision = DECISION_PAGES.includes(pageNum);
      let beat: Beat = { scene: "", choices: [], focus_char: 'other' };

      if (type === 'cover') {
           // Cover beat is handled in generateImage
      } else if (type === 'back_cover') {
           beat = { scene: "Thematic teaser image", choices: [], focus_char: 'other' };
      } else {
           beat = await generateBeat(historyRef.current, pageNum % 2 === 0, pageNum, isDecision);
      }

      if (beat.focus_char === 'friend' && !friendRef.current && type === 'story') {
          try {
              const newSidekick = await generatePersona(selectedGenre === 'Custom' ? "A fitting sidekick for this story" : `Sidekick for ${selectedGenre} story.`);
              setFriend(newSidekick);
          } catch (e) { beat.focus_char = 'other'; }
      }

      updateFaceState(faceId, { narrative: beat, choices: beat.choices, isDecisionPage: isDecision });
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

              // Apply pre-generated beat or fallback
              if (preGeneratedBeats && preGeneratedBeats[i]) {
                  updateFaceState(`page-${pageNum}`, { narrative: preGeneratedBeats[i] });
              }

              await generateSinglePage(`page-${pageNum}`, pageNum, type);
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
