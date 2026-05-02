export default async function handler(req, res) {
  const { prompt } = req.query;
  const hfToken = process.env.VITE_HF_TOKEN;

  if (!prompt) {
    return res.status(400).json({ error: 'Prompt is required' });
  }

  const fetchWithRetry = async (url, options, retries = 3, backoff = 2000) => {
    try {
      const response = await fetch(url, options);
      if (response.status === 429 && retries > 0) {
        console.warn(`Rate limited. Retrying in ${backoff}ms...`);
        await new Promise(r => setTimeout(r, backoff));
        return fetchWithRetry(url, options, retries - 1, backoff * 2);
      }
      return response;
    } catch (e) {
      if (retries > 0) {
        await new Promise(r => setTimeout(r, backoff));
        return fetchWithRetry(url, options, retries - 1, backoff * 2);
      }
      throw e;
    }
  };

  try {
    let imageResponse;

    // 1. Primary: Hugging Face SDXL (if token exists)
    if (hfToken) {
      const hfUrl = "https://api-inference.huggingface.co/models/stabilityai/stable-diffusion-xl-base-1.0";
      imageResponse = await fetchWithRetry(hfUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${hfToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ inputs: prompt }),
      });
    }

    // 2. Secondary: Fallback to Pollinations
    if (!imageResponse || !imageResponse.ok) {
      const cleanPrompt = encodeURIComponent(prompt.trim());
      const seed = Math.floor(Math.random() * 1000000);
      const pollUrl = `https://image.pollinations.ai/prompt/${cleanPrompt}?width=768&height=768&nologo=true&seed=${seed}`;
      
      imageResponse = await fetchWithRetry(pollUrl, {
        method: 'GET',
        headers: { 'User-Agent': 'Infinite-Heroes-SaaS/1.0' }
      });
    }

    if (!imageResponse.ok) {
      throw new Error(`Upstream API responded with ${imageResponse.status}`);
    }

    const arrayBuffer = await imageResponse.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 's-maxage=86400');
    res.setHeader('Access-Control-Allow-Origin', '*'); 
    res.send(buffer);

  } catch (error) {
    console.error('Serverless Fetch Error:', error);
    res.status(500).json({ error: 'Failed to generate image' });
  }
}
