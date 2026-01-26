interface Env {
	HELIUS_API_KEY: string;
	CORS_ALLOW_ORIGIN?: string;
	BACKEND_WEBHOOK_URL: string; // Add your Railway/Vercel URL here
	WEBHOOK_SECRET?: string;      // Optional: Shared secret to verify Helius calls
}

// Configuration - adjust as needed
const BUFFER_TIMEOUT_MS = 10000;
const KEEPALIVE_INTERVAL_MS = 20000;
const MAX_BUFFER_SIZE = 10;

const KEEPALIVE_MESSAGE = JSON.stringify({
	jsonrpc: "2.0",
	method: "helius_keepalive"
});

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		// 1. ROUTE: Helius Webhook Listener
		// Point Helius to: https://your-worker.workers.dev/helius-webhook
		if (url.pathname === '/helius-webhook') {
			return handleWebhookForwarding(request, env);
		}

		// 2. SECURITY: Validate Environment
		if (!env.HELIUS_API_KEY) {
			return new Response('Missing HELIUS_API_KEY', { status: 500 });
		}

		// 3. CORS & PREFLIGHT (Keep existing logic)
		const corsHeaders = getCorsHeaders(request, env);
		if (request.method === 'OPTIONS') {
			return new Response(null, { status: 200, headers: corsHeaders });
		}

		// 4. ROUTE: WebSocket Handling
		const upgrade = request.headers.get('Upgrade')?.toLowerCase();
		if (upgrade === 'websocket') {
			return handleWebSocket(request, env, corsHeaders);
		}

		// 5. ROUTE: Standard RPC Proxy (with IP Anonymization)
		return handleRPC(request, env, corsHeaders);
	},
};

/**
 * Forwards Helius Webhooks to your real backend server.
 * This acts as a shield so Helius never talks directly to your origin.
 */
async function handleWebhookForwarding(request: Request, env: Env): Promise<Response> {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 });
	}

	// Optional: Check a custom auth header you set in the Helius Dashboard
	if (env.WEBHOOK_SECRET) {
		const authHeader = request.headers.get('Authorization');
		if (authHeader !== env.WEBHOOK_SECRET) {
			return new Response('Unauthorized', { status: 401 });
		}
	}

	const payload = await request.text();

	// Forward the webhook to your Railway/Vercel backend
	const backendResponse = await fetch(env.BACKEND_WEBHOOK_URL, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'X-Forwarded-From': 'Cloudflare-Worker-Shield'
		},
		body: payload
	});

	return new Response(backendResponse.body, { status: backendResponse.status });
}


async function handleWebSocket(request: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
	const { search } = new URL(request.url);
	const upstreamUrl = `wss://mainnet.helius-rpc.com${search ? `${search}&` : '?'}api-key=${env.HELIUS_API_KEY}`;

	// Extract subprotocol
	const clientProtocols = request.headers.get('Sec-WebSocket-Protocol');
	const selectedProtocol = clientProtocols?.split(',')[0]?.trim();

	// Create WebSocket pair
	const webSocketPair = new WebSocketPair();
	const [client, server] = Object.values(webSocketPair);
	server.accept();

	// Connect upstream
	const upstream = selectedProtocol
		? new WebSocket(upstreamUrl, [selectedProtocol])
		: new WebSocket(upstreamUrl);

	// Message buffering for race condition fix
	let bufferedData: (string | ArrayBuffer)[] = [];
	let bufferTimeout: ReturnType<typeof setTimeout> | null = null;
	let isUpstreamConnected = false;

	// Keepalive management
	let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

	const startKeepalive = () => {
		keepaliveTimer = setInterval(() => {
			if (upstream.readyState === WebSocket.OPEN) {
				try {
					upstream.send(KEEPALIVE_MESSAGE);
				} catch {
					clearKeepalive();
				}
			} else {
				clearKeepalive();
			}
		}, KEEPALIVE_INTERVAL_MS);
	};

	const clearKeepalive = () => {
		if (keepaliveTimer) {
			clearInterval(keepaliveTimer);
			keepaliveTimer = null;
		}
	};

	const clearBufferTimeout = () => {
		if (bufferTimeout) {
			clearTimeout(bufferTimeout);
			bufferTimeout = null;
		}
	};

	const startBufferTimeout = () => {
		clearBufferTimeout();
		bufferTimeout = setTimeout(() => {
			if (bufferedData.length > 0 && !isUpstreamConnected) {
				bufferedData = [];
				try {
					server.close(1011, "upstream_connection_timeout");
				} catch { }
			}
		}, BUFFER_TIMEOUT_MS);
	};

	const cleanup = () => {
		clearKeepalive();
		clearBufferTimeout();
		bufferedData = [];
	};

	// Upstream connection open
	upstream.addEventListener('open', () => {
		isUpstreamConnected = true;
		clearBufferTimeout();

		// Send buffered messages
		if (bufferedData.length > 0) {
			try {
				for (const data of bufferedData) {
					upstream.send(data);
				}
				bufferedData = [];
			} catch {
				cleanup();
				try { server.close(1011, "upstream_ws_error"); } catch { }
				return;
			}
		}
		startKeepalive();
	});

	// Client to upstream forwarding
	server.addEventListener('message', event => {
		if (isUpstreamConnected && upstream.readyState === WebSocket.OPEN) {
			try {
				upstream.send(event.data);
			} catch {
				cleanup();
				try { server.close(1011, "upstream_ws_error"); } catch { }
			}
		} else {
			// Buffer with size limit
			if (bufferedData.length >= MAX_BUFFER_SIZE) {
				cleanup();
				try { server.close(1011, "buffer_overflow"); } catch { }
				return;
			}

			if (bufferedData.length === 0) {
				startBufferTimeout();
			}
			bufferedData.push(event.data);
		}
	});

	// Upstream to client forwarding
	upstream.addEventListener('message', event => {
		if (server.readyState === WebSocket.OPEN) {
			try {
				server.send(event.data);
			} catch {
				cleanup();
				try { upstream.close(1011, "client_ws_error"); } catch { }
			}
		}
	});

	// Connection close handling
	server.addEventListener('close', () => {
		cleanup();
		try { upstream.close(); } catch { }
	});

	upstream.addEventListener('close', () => {
		isUpstreamConnected = false;
		cleanup();
		try { server.close(); } catch { }
	});

	// Error handling
	server.addEventListener('error', () => {
		cleanup();
		try { upstream.close(1011, "client_ws_error"); } catch { }
	});

	upstream.addEventListener('error', () => {
		isUpstreamConnected = false;
		cleanup();
		try { server.close(1011, "upstream_ws_error"); } catch { }
	});

	// Response
	const responseHeaders: Record<string, string> = { ...corsHeaders };
	if (selectedProtocol) {
		responseHeaders['Sec-WebSocket-Protocol'] = selectedProtocol;
	}

	return new Response(null, {
		status: 101,
		webSocket: client,
		headers: responseHeaders,
	});
}

async function handleRPC(request: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
	try {
		const { pathname, search } = new URL(request.url);
		const payload = await request.text();

		const targetHost = pathname === '/' ? 'mainnet.helius-rpc.com' : 'api.helius.xyz';
		const targetUrl = `https://${targetHost}${pathname}?api-key=${env.HELIUS_API_KEY}${search ? `&${search.slice(1)}` : ''}`;

		// ANONYMIZATION: Create new headers and strip the user's real IP
		const anonymizedHeaders = new Headers(request.headers);
		anonymizedHeaders.delete("cf-connecting-ip");
		anonymizedHeaders.delete("x-forwarded-for");
		anonymizedHeaders.delete("true-client-ip");
		
		// Set standard content type
		anonymizedHeaders.set('Content-Type', 'application/json');

		const proxyRequest = new Request(targetUrl, {
			method: request.method,
			body: payload || null,
			headers: anonymizedHeaders
		});

		const response = await fetch(proxyRequest);
		return new Response(response.body, { status: response.status, headers: corsHeaders });
	} catch {
		return new Response('Proxy Error', { status: 502, headers: corsHeaders });
	}
}

// Helper for CORS logic
function getCorsHeaders(request: Request, env: Env): Record<string, string> {
	const supportedDomains = env.CORS_ALLOW_ORIGIN?.split(',').map(d => d.trim());
	const headers: Record<string, string> = {
		'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type, Authorization',
	};
	const origin = request.headers.get('Origin');
	if (supportedDomains && origin && supportedDomains.includes(origin)) {
		headers['Access-Control-Allow-Origin'] = origin;
	} else {
		headers['Access-Control-Allow-Origin'] = '*';
	}
	return headers;
}