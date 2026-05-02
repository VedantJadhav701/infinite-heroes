export default async function handler(req, res) {
  const { prompt } = req.query;

  if (!prompt) {
    return res.status(400).json({ error: 'Prompt is required' });
  }

  const cleanPrompt = encodeURIComponent(prompt.trim());
  const seed = Math.floor(Math.random() * 1000000);
  const targetUrl = `https://image.pollinations.ai/prompt/${cleanPrompt}?width=768&height=768&nologo=true&seed=${seed}`;

  try {
    const imageResponse = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'Infinite-Heroes-SaaS/1.0',
      }
    });

    if (!imageResponse.ok) {
      throw new Error(`API responded with ${imageResponse.status}`);
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
