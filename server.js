const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const ROOT = __dirname;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf'
};

function httpsRequestJson(url, method = 'GET', postData = null) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method,
      headers: {}
    };

    let bodyStr = null;
    if (postData) {
      bodyStr = typeof postData === 'string' ? postData : JSON.stringify(postData);
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', (chunk) => {
        raw += chunk;
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(raw));
        } catch (e) {
          reject(new Error('Risposta non JSON da Meta Graph API'));
        }
      });
    });

    req.on('error', (err) => reject(err));
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function readRequestBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        resolve({});
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
  const safePath = decodeURIComponent(parsedUrl.pathname);

  // ==========================================================================
  // 1. CONNETTORE DA FACEBOOK (GET /api/facebook-sync)
  // ==========================================================================
  if (safePath === '/api/facebook-sync') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const token = (parsedUrl.searchParams.get('token') || '').trim();
    const requestedPage = (parsedUrl.searchParams.get('pageId') || 'associazionepassioneinfinita')
      .trim()
      .replace(/^https?:\/\/(www\.)?facebook\.com\//i, '')
      .replace(/\/.*$/, '');

    if (!token) {
      res.writeHead(200);
      return res.end(
        JSON.stringify({
          ok: false,
          mode: 'demo',
          error: 'Nessun token Meta Graph API inserito (attiva modalità simulazione locale).'
        })
      );
    }

    try {
      const meData = await httpsRequestJson(
        `https://graph.facebook.com/v19.0/me?fields=id,name&access_token=${encodeURIComponent(token)}`
      );
      if (meData.error) {
        res.writeHead(200);
        return res.end(
          JSON.stringify({
            ok: false,
            stage: 'token_check',
            error: meData.error.message,
            code: meData.error.code
          })
        );
      }

      let targetId = meData.id;
      let targetName = meData.name || requestedPage;
      let effectiveToken = token;
      let igBusinessId = null;

      const accountsData = await httpsRequestJson(
        `https://graph.facebook.com/v19.0/me/accounts?fields=id,name,username,access_token,instagram_business_account&access_token=${encodeURIComponent(token)}`
      );
      if (accountsData && Array.isArray(accountsData.data) && accountsData.data.length > 0) {
        const match =
          accountsData.data.find(
            (p) =>
              (p.username && p.username.toLowerCase() === requestedPage.toLowerCase()) ||
              (p.name && p.name.toLowerCase().includes('passione')) ||
              p.id === requestedPage
          ) || accountsData.data[0];

        targetId = match.id;
        targetName = match.name;
        if (match.access_token) effectiveToken = match.access_token;
        if (match.instagram_business_account && match.instagram_business_account.id) {
          igBusinessId = match.instagram_business_account.id;
        }
      }

      const richFields =
        'id,message,story,created_time,full_picture,permalink_url,attachments{media_type,url,media}';
      let postsData = await httpsRequestJson(
        `https://graph.facebook.com/v19.0/${encodeURIComponent(targetId)}/posts?fields=${encodeURIComponent(
          richFields
        )}&limit=10&access_token=${encodeURIComponent(effectiveToken)}`
      );

      if (postsData.error) {
        postsData = await httpsRequestJson(
          `https://graph.facebook.com/v19.0/${encodeURIComponent(
            targetId
          )}/feed?fields=id,message,story,created_time,permalink_url&limit=10&access_token=${encodeURIComponent(
            effectiveToken
          )}`
        );
      }

      res.writeHead(200);
      return res.end(
        JSON.stringify({
          ok: !postsData.error,
          identity: { id: targetId, name: targetName, igBusinessId },
          posts: (postsData && postsData.data) || [],
          apiWarning: postsData.error ? postsData.error.message : null
        })
      );
    } catch (err) {
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  }

  // ==========================================================================
  // 2. CONNETTORE VERSO FACEBOOK (POST /api/facebook-publish)
  // ==========================================================================
  if (safePath === '/api/facebook-publish' && req.method === 'POST') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const body = await readRequestBody(req);
    const token = (body.token || '').trim();
    const message = (body.message || '').trim();
    const mediaUrl = (body.mediaUrl || '').trim();

    if (!token) {
      res.writeHead(200);
      return res.end(
        JSON.stringify({
          ok: true,
          simulated: true,
          postId: 'fb-local-' + Date.now(),
          details:
            'Pubblicazione registrata in modalità locale (inserisci un Page Access Token con permesso pages_manage_posts per inviare in produzione su graph.facebook.com).'
        })
      );
    }

    try {
      const meData = await httpsRequestJson(
        `https://graph.facebook.com/v19.0/me?fields=id,name&access_token=${encodeURIComponent(token)}`
      );
      if (meData.error) {
        res.writeHead(200);
        return res.end(JSON.stringify({ ok: false, error: meData.error.message }));
      }

      let targetId = meData.id;
      let effectiveToken = token;
      const accountsData = await httpsRequestJson(
        `https://graph.facebook.com/v19.0/me/accounts?fields=id,name,access_token&access_token=${encodeURIComponent(token)}`
      );
      if (accountsData && Array.isArray(accountsData.data) && accountsData.data.length > 0) {
        const match =
          accountsData.data.find((p) => p.name && p.name.toLowerCase().includes('passione')) ||
          accountsData.data[0];
        targetId = match.id;
        if (match.access_token) effectiveToken = match.access_token;
      }

      const publishEndpoint =
        mediaUrl && /^https?:\/\//i.test(mediaUrl)
          ? `https://graph.facebook.com/v19.0/${encodeURIComponent(targetId)}/photos?access_token=${encodeURIComponent(effectiveToken)}`
          : `https://graph.facebook.com/v19.0/${encodeURIComponent(targetId)}/feed?access_token=${encodeURIComponent(effectiveToken)}`;

      const payload =
        mediaUrl && /^https?:\/\//i.test(mediaUrl)
          ? { url: mediaUrl, caption: message }
          : { message };

      const pubRes = await httpsRequestJson(publishEndpoint, 'POST', payload);
      if (pubRes.error) {
        res.writeHead(200);
        return res.end(
          JSON.stringify({
            ok: false,
            error: pubRes.error.message,
            code: pubRes.error.code
          })
        );
      }

      res.writeHead(200);
      return res.end(
        JSON.stringify({
          ok: true,
          simulated: false,
          postId: pubRes.id || pubRes.post_id,
          details: `Post pubblicato con successo sulla Pagina Facebook (ID: ${pubRes.id || pubRes.post_id}).`
        })
      );
    } catch (err) {
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  }

  // ==========================================================================
  // 3. CONNETTORE DA INSTAGRAM (GET /api/instagram-sync)
  //    Pagina ufficiale: https://www.instagram.com/ass.passioneinfinita/
  // ==========================================================================
  if (safePath === '/api/instagram-sync') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const token = (parsedUrl.searchParams.get('token') || '').trim();
    const igAccountId = (parsedUrl.searchParams.get('igAccountId') || '').trim();

    if (!token) {
      res.writeHead(200);
      return res.end(
        JSON.stringify({
          ok: false,
          mode: 'demo',
          error: 'Nessun token Instagram Graph API inserito (attiva modalità simulazione locale per @ass.passioneinfinita).'
        })
      );
    }

    try {
      let resolvedIgId = igAccountId && /^\d+$/.test(igAccountId) ? igAccountId : null;
      let resolvedUsername = 'ass.passioneinfinita';

      if (!resolvedIgId) {
        const accountsData = await httpsRequestJson(
          `https://graph.facebook.com/v19.0/me/accounts?fields=id,name,instagram_business_account{id,username,name,profile_picture_url}&access_token=${encodeURIComponent(token)}`
        );
        if (accountsData && Array.isArray(accountsData.data)) {
          const withIg = accountsData.data.find((p) => p.instagram_business_account && p.instagram_business_account.id);
          if (withIg) {
            resolvedIgId = withIg.instagram_business_account.id;
            resolvedUsername = withIg.instagram_business_account.username || resolvedUsername;
          }
        }
      }

      if (!resolvedIgId) {
        res.writeHead(200);
        return res.end(
          JSON.stringify({
            ok: false,
            stage: 'ig_discovery',
            error:
              'Token valido, ma nessun account Instagram Business collegato trovato. Assicurati che @ass.passioneinfinita sia collegato alla Pagina Facebook e che il token includa i permessi instagram_basic e pages_show_list.'
          })
        );
      }

      const igFields = 'id,caption,media_type,media_url,permalink,thumbnail_url,timestamp,username,like_count,comments_count';
      const mediaData = await httpsRequestJson(
        `https://graph.facebook.com/v19.0/${encodeURIComponent(resolvedIgId)}/media?fields=${encodeURIComponent(
          igFields
        )}&limit=10&access_token=${encodeURIComponent(token)}`
      );

      if (mediaData.error) {
        res.writeHead(200);
        return res.end(
          JSON.stringify({
            ok: false,
            stage: 'ig_media_fetch',
            error: mediaData.error.message,
            code: mediaData.error.code
          })
        );
      }

      res.writeHead(200);
      return res.end(
        JSON.stringify({
          ok: true,
          identity: { id: resolvedIgId, username: resolvedUsername },
          posts: mediaData.data || []
        })
      );
    } catch (err) {
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  }

  // ==========================================================================
  // 4. CONNETTORE VERSO INSTAGRAM (POST /api/instagram-publish)
  // ==========================================================================
  if (safePath === '/api/instagram-publish' && req.method === 'POST') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const body = await readRequestBody(req);
    const token = (body.token || '').trim();
    const igAccountId = (body.igAccountId || '').trim();
    const caption = (body.caption || '').trim();
    const imageUrl = (body.imageUrl || '').trim();

    if (!token || !/^\d+$/.test(igAccountId) || !/^https?:\/\//i.test(imageUrl)) {
      res.writeHead(200);
      return res.end(
        JSON.stringify({
          ok: true,
          simulated: true,
          postId: 'ig-local-' + Date.now(),
          details:
            'Contenuto registrato e sincronizzato per @ass.passioneinfinita (per la pubblicazione diretta su Instagram Graph API occorre un Token con instagram_content_publish e un URL immagine pubblico).'
        })
      );
    }

    try {
      const containerRes = await httpsRequestJson(
        `https://graph.facebook.com/v19.0/${encodeURIComponent(igAccountId)}/media?access_token=${encodeURIComponent(token)}`,
        'POST',
        { image_url: imageUrl, caption }
      );
      if (containerRes.error) {
        res.writeHead(200);
        return res.end(JSON.stringify({ ok: false, error: containerRes.error.message }));
      }

      const publishRes = await httpsRequestJson(
        `https://graph.facebook.com/v19.0/${encodeURIComponent(igAccountId)}/media_publish?access_token=${encodeURIComponent(token)}`,
        'POST',
        { creation_id: containerRes.id }
      );
      if (publishRes.error) {
        res.writeHead(200);
        return res.end(JSON.stringify({ ok: false, error: publishRes.error.message }));
      }

      res.writeHead(200);
      return res.end(
        JSON.stringify({
          ok: true,
          simulated: false,
          postId: publishRes.id,
          details: `Post pubblicato con successo su Instagram @ass.passioneinfinita (ID: ${publishRes.id}).`
        })
      );
    } catch (err) {
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  }

  let filePath = path.join(ROOT, safePath === '/' ? 'index.html' : safePath);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.stat(filePath, (err, stats) => {
    if (err || stats.isDirectory()) {
      filePath = path.join(ROOT, 'index.html');
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (readErr, content) => {
      if (readErr) {
        res.writeHead(404);
        return res.end('Not found');
      }
      res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
      res.end(content);
    });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Passione Infinita PWA attiva su http://localhost:${PORT}`);
});
