// Cloudflare Worker - Image Generation Proxy
// Simple proxy for Pollinations AI with usage tracking

export default {
  async fetch(request, env, ctx) {
    // 1. CORS Headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    };

    // Handle Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    // Handle image upload to Cloudflare Images FIRST (before asset serving)
    if (url.pathname === '/upload' && request.method === 'POST') {
      if (!env.CF_IMAGES_ACCOUNT_ID || !env.CF_IMAGES_API_TOKEN) {
        return new Response(JSON.stringify({ error: 'Cloudflare Images not configured' }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      try {
        const formData = await request.formData();
        const imageFile = formData.get('file');
        
        if (!imageFile) {
          return new Response(JSON.stringify({ error: 'No file provided' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        // Create a new File with proper content type
        const imageBlob = new File(
          [await imageFile.arrayBuffer()], 
          imageFile.name || 'image.png',
          { type: imageFile.type || 'image/png' }
        );

        // Upload to Cloudflare Images
        const uploadFormData = new FormData();
        uploadFormData.append('file', imageBlob);
        
        const uploadUrl = `https://api.cloudflare.com/client/v4/accounts/${env.CF_IMAGES_ACCOUNT_ID}/images/v1`;
        const uploadResponse = await fetch(uploadUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.CF_IMAGES_API_TOKEN}`
          },
          body: uploadFormData
        });

        const uploadResult = await uploadResponse.json();
        
        if (!uploadResult.success) {
          console.error('Cloudflare Images upload failed:', uploadResult);
          return new Response(JSON.stringify({ 
            error: 'Upload failed', 
            details: uploadResult.errors || uploadResult.messages 
          }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        // Build custom variant URL with background removal, trimming, and resizing
        const baseUrl = uploadResult.result.variants[0].split('/public')[0];
        const customUrl = `${baseUrl}/segment=foreground,trim=10,width=512,height=512,fit=pad,format=png`;

        // Return the image URLs
        return new Response(JSON.stringify({
          success: true,
          id: uploadResult.result.id,
          url: customUrl,
          variants: uploadResult.result.variants
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });

      } catch (error) {
        console.error('Upload error:', error);
        return new Response(JSON.stringify({ error: 'Upload error', message: error.message }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }

    // Handle club search API (Supabase proxy)
    if (url.pathname === '/api/clubs' && request.method === 'GET') {
      if (!env.SUPABASE_URL || !env.SUPABASE_KEY) {
        return new Response(JSON.stringify({ error: 'Supabase not configured' }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      const searchTerm = url.searchParams.get('search');
      const limit = url.searchParams.get('limit') || '50';

      if (!searchTerm || searchTerm.length < 2) {
        return new Response(JSON.stringify([]), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      try {
        const supabaseUrl = `${env.SUPABASE_URL}/rest/v1/clubs?Name=ilike.*${encodeURIComponent(searchTerm)}*&select=*&order=Rep.desc.nullslast&limit=${limit}`;
        
        const response = await fetch(supabaseUrl, {
          headers: {
            'apikey': env.SUPABASE_KEY,
            'Authorization': `Bearer ${env.SUPABASE_KEY}`,
            'Content-Type': 'application/json'
          }
        });

        if (!response.ok) {
          throw new Error(`Supabase error: ${response.status}`);
        }

        const data = await response.json();
        
        return new Response(JSON.stringify(data), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' }
        });

      } catch (error) {
        console.error('Club search error:', error);
        return new Response(JSON.stringify({ error: 'Search failed', message: error.message }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }

    // Handle API endpoint for image generation - use /api path instead
    if (url.pathname === '/api' && url.searchParams.has('prompt') && request.method === 'GET') {
      // 3. Parse Parameters
      const prompt = url.searchParams.get('prompt');
      const model = url.searchParams.get('model') || 'flux';
      const width = url.searchParams.get('width') || '1024';
      const height = url.searchParams.get('height') || '1024';
      
      // 4. Get API key - use provided auth header or fall back to stored POLLEN_API_KEY
      const authHeader = request.headers.get('Authorization');
      let apiKey;
      
      if (authHeader && authHeader.startsWith('Bearer ')) {
        apiKey = authHeader.replace('Bearer ', '');
      } else if (env.POLLEN_API_KEY) {
        // Use stored API key from Cloudflare environment variables
        apiKey = env.POLLEN_API_KEY;
      } else {
        return new Response('Unauthorized: No API key configured', { 
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'text/plain' }
        });
      }
      const seed = url.searchParams.get('seed') || '';
      
      // Pollinations params
      const nologo = url.searchParams.get('nologo') || 'true';
      const enhance = url.searchParams.get('enhance') || 'true';
      const quality = url.searchParams.get('quality') || 'hd';
      const safe = url.searchParams.get('safe') || 'false';
      const negativePrompt = url.searchParams.get('negative_prompt') || '';

      if (!prompt) {
        return new Response('Missing prompt parameter', { status: 400, headers: corsHeaders });
      }

      // 5. Build Pollinations URL
      const encodedPrompt = encodeURIComponent(prompt);
      let pollinationsUrl = `https://gen.pollinations.ai/image/${encodedPrompt}?model=${model}&width=${width}&height=${height}&nologo=${nologo}&quality=${quality}&safe=${safe}`;
      if (seed) pollinationsUrl += `&seed=${seed}`;
      if (negativePrompt) pollinationsUrl += `&negative_prompt=${encodeURIComponent(negativePrompt)}`;

      try {
        // 6. Fetch from Pollinations with user's API key
        const response = await fetch(pollinationsUrl, {
          headers: {
            'Authorization': `Bearer ${apiKey}`
          }
        });

        if (!response.ok) {
          return new Response(`Pollinations Error: ${response.status}`, { status: response.status, headers: corsHeaders });
        }

        const imageArrayBuffer = await response.arrayBuffer();
        
        return new Response(imageArrayBuffer, {
          headers: {
            ...corsHeaders,
            'Content-Type': 'image/png',
            'Cache-Control': 'public, max-age=3600'
          },
        });

      } catch (error) {
        return new Response(`Worker Error: ${error.message}`, { status: 500, headers: corsHeaders });
      }
    }

    // Handle text generation API endpoint
    if (url.pathname === '/api/text' && url.searchParams.has('prompt') && request.method === 'GET') {
      // Parse Parameters
      const prompt = url.searchParams.get('prompt');
      const system = url.searchParams.get('system') || '';
      const model = url.searchParams.get('model') || 'gemini-fast';
      const temperature = url.searchParams.get('temperature') || '0.3';
      const json = url.searchParams.get('json') || 'true';
      const seed = url.searchParams.get('seed') || '-1';
      
      // Get API key - use provided auth header or fall back to stored POLLEN_API_KEY
      const authHeader = request.headers.get('Authorization');
      let apiKey;
      
      if (authHeader && authHeader.startsWith('Bearer ')) {
        apiKey = authHeader.replace('Bearer ', '');
      } else if (env.POLLEN_API_KEY) {
        // Use stored API key from Cloudflare environment variables
        apiKey = env.POLLEN_API_KEY;
      } else {
        return new Response('Unauthorized: No API key configured', { 
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'text/plain' }
        });
      }

      if (!prompt) {
        return new Response('Missing prompt parameter', { status: 400, headers: corsHeaders });
      }

      // Build Pollinations URL for text generation
      let pollinationsUrl = `https://gen.pollinations.ai/text/${encodeURIComponent(prompt)}?model=${model}&temperature=${temperature}&json=${json}&seed=${seed}`;
      if (system) pollinationsUrl += `&system=${encodeURIComponent(system)}`;

      try {
        // Fetch from Pollinations with API key
        const response = await fetch(pollinationsUrl, {
          headers: {
            'Authorization': `Bearer ${apiKey}`
          }
        });

        if (!response.ok) {
          return new Response(`Pollinations Error: ${response.status}`, { status: response.status, headers: corsHeaders });
        }

        const textResponse = await response.text();
        
        return new Response(textResponse, {
          headers: {
            ...corsHeaders,
            'Content-Type': 'text/plain',
            'Cache-Control': 'public, max-age=3600'
          },
        });

      } catch (error) {
        return new Response(`Worker Error: ${error.message}`, { status: 500, headers: corsHeaders });
      }
    }

    // Serve index.html on root path
    if (url.pathname === '/') {
      return env.ASSETS.fetch(request);
    }

    // For all other paths, try serving static assets
    return env.ASSETS.fetch(request);
  },
};