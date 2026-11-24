<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>303-XMD — Web Pairing</title>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --primary: #00ff88;
      --bg: #0a0a0c;
      --card: rgba(25, 25, 30, 0.6);
      --border: rgba(255, 255, 255, 0.1);
      --text: #ffffff;
      --muted: #8b8b93;
    }

    * { margin: 0; padding: 0; box-sizing: border-box; font-family: 'Outfit', sans-serif; }

    body {
      background-color: var(--bg);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background-image: 
        radial-gradient(circle at 15% 50%, rgba(0, 255, 136, 0.08) 0%, transparent 50%),
        radial-gradient(circle at 85% 30%, rgba(0, 150, 255, 0.08) 0%, transparent 50%);
      overflow: hidden;
    }

    .glass-panel {
      background: var(--card);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid var(--border);
      border-radius: 24px;
      padding: 40px;
      width: 100%;
      max-width: 420px;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
      text-align: center;
      position: relative;
      z-index: 10;
    }

    .logo {
      font-size: 28px;
      font-weight: 800;
      letter-spacing: -1px;
      margin-bottom: 8px;
      background: linear-gradient(90deg, #fff, var(--primary));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .subtitle {
      color: var(--muted);
      font-size: 14px;
      margin-bottom: 32px;
    }

    .input-group {
      margin-bottom: 20px;
      text-align: left;
    }

    .input-group label {
      display: block;
      font-size: 12px;
      color: var(--muted);
      margin-bottom: 8px;
      margin-left: 4px;
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    .input-group input {
      width: 100%;
      background: rgba(0, 0, 0, 0.2);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 16px;
      color: var(--text);
      font-size: 16px;
      outline: none;
      transition: all 0.3s ease;
    }

    .input-group input:focus {
      border-color: var(--primary);
      box-shadow: 0 0 0 3px rgba(0, 255, 136, 0.1);
    }

    button {
      width: 100%;
      padding: 16px;
      border-radius: 12px;
      border: none;
      background: var(--primary);
      color: #000;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.3s ease;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
    }

    button:hover {
      transform: translateY(-2px);
      box-shadow: 0 10px 20px -10px var(--primary);
    }

    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      transform: none;
      box-shadow: none;
    }

    /* Result Area */
    #result-area {
      display: none;
      margin-top: 24px;
      padding-top: 24px;
      border-top: 1px solid var(--border);
      animation: fadeIn 0.5s ease;
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .code-box {
      background: rgba(0, 255, 136, 0.1);
      border: 1px dashed var(--primary);
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 16px;
    }

    .code-box p {
      color: var(--muted);
      font-size: 13px;
      margin-bottom: 8px;
    }

    .code {
      font-size: 32px;
      font-weight: 800;
      letter-spacing: 4px;
      color: var(--primary);
      user-select: all;
    }

    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 16px;
      border-radius: 20px;
      font-size: 13px;
      font-weight: 600;
      background: rgba(255, 255, 255, 0.05);
      color: var(--muted);
    }

    .status-badge.connected {
      background: rgba(0, 255, 136, 0.15);
      color: var(--primary);
    }

    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--muted);
    }

    .status-badge.connected .dot {
      background: var(--primary);
      box-shadow: 0 0 10px var(--primary);
      animation: pulse 2s infinite;
    }

    @keyframes pulse {
      0% { box-shadow: 0 0 0 0 rgba(0, 255, 136, 0.4); }
      70% { box-shadow: 0 0 0 10px rgba(0, 255, 136, 0); }
      100% { box-shadow: 0 0 0 0 rgba(0, 255, 136, 0); }
    }

    .loader {
      display: none;
      width: 20px;
      height: 20px;
      border: 3px solid rgba(0,0,0,0.3);
      border-radius: 50%;
      border-top-color: #000;
      animation: spin 1s ease-in-out infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .error-msg {
      color: #ff4a4a;
      font-size: 14px;
      margin-top: 12px;
      display: none;
    }

    .footer {
      margin-top: 30px;
      font-size: 12px;
      color: var(--muted);
    }
  </style>
</head>
<body>

  <div class="glass-panel">
    <div class="logo">303-XMD</div>
    <div class="subtitle">THE LAST KEY — Web Pairing</div>

    <div class="input-group">
      <label for="phone">WhatsApp Number (with country code)</label>
      <input type="tel" id="phone" placeholder="e.g. 254794376595" autocomplete="off">
    </div>

    <button id="pair-btn" onclick="requestCode()">
      <span id="btn-text">Generate Pairing Code</span>
      <div class="loader" id="btn-loader"></div>
    </button>

    <div class="error-msg" id="error-msg"></div>

    <div id="result-area">
      <div class="code-box">
        <p>Enter this code on your WhatsApp:</p>
        <div class="code" id="pairing-code">----</div>
      </div>
      
      <div class="status-badge" id="status-badge">
        <div class="dot"></div>
        <span id="status-text">Waiting for connection...</span>
      </div>
    </div>

    <div class="footer">
      &copy; 2026 303-XMD. Powered by Baileys.
    </div>
  </div>

  <script>
    let pollInterval = null;
    let currentSessionId = null;

    async function requestCode() {
      const phoneInput = document.getElementById('phone');
      const phone = phoneInput.value.replace(/[^0-9]/g, '');
      
      const btn = document.getElementById('pair-btn');
      const btnText = document.getElementById('btn-text');
      const loader = document.getElementById('btn-loader');
      const errorMsg = document.getElementById('error-msg');
      const resultArea = document.getElementById('result-area');

      // Reset
      errorMsg.style.display = 'none';
      
      if (phone.length < 10 || phone.length > 15) {
        showError("Please enter a valid phone number with country code.");
        return;
      }

      // UI Loading state
      btn.disabled = true;
      btnText.style.display = 'none';
      loader.style.display = 'block';

      try {
        const response = await fetch('/pair', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone: phone })
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || "Failed to generate code");
        }

        // Success
        currentSessionId = data.sessionId;
        document.getElementById('pairing-code').innerText = data.code;
        resultArea.style.display = 'block';
        
        // Start checking connection status
        startPolling(data.sessionId);

      } catch (err) {
        showError(err.message);
      } finally {
        // Reset button UI
        btn.disabled = false;
        btnText.style.display = 'block';
        loader.style.display = 'none';
      }
    }

    function startPolling(sessionId) {
      if (pollInterval) clearInterval(pollInterval);
      
      const badge = document.getElementById('status-badge');
      const statusText = document.getElementById('status-text');

      pollInterval = setInterval(async () => {
        try {
          const res = await fetch(`/status/${sessionId}`);
          if (!res.ok) return;
          
          const data = await res.json();
          
          if (data.connected) {
            clearInterval(pollInterval);
            badge.classList.add('connected');
            statusText.innerText = "Connected Successfully! ✅";
          } else if (data.socketReady) {
            statusText.innerText = "Socket ready, waiting for WhatsApp...";
          }
        } catch (e) {
          console.error("Polling error", e);
        }
      }, 3000); // Check every 3 seconds
    }

    function showError(msg) {
      const errorMsg = document.getElementById('error-msg');
      errorMsg.innerText = msg;
      errorMsg.style.display = 'block';
    }

    // Allow pressing Enter to submit
    document.getElementById('phone').addEventListener('keypress', function (e) {
      if (e.key === 'Enter') requestCode();
    });
  </script>
</body>
</html>
