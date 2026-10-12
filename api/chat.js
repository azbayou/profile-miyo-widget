// Cache in-memory untuk menghemat request & mempercepat respons (5 menit)
let cachedSheetData = null;
let lastFetchTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

// URL Google Sheets Tab "miyo" (Format CSV via Google Visualization API)
const GSHEET_CSV_URL =
  "https://docs.google.com/spreadsheets/d/1-TtuuskcO0mvZWAO8pg26MHNfn9NdfrIPeuSlP7Kaug/gviz/tq?tqx=out:csv&gid=561116560";

async function fetchGoogleSheetData() {
  const now = Date.now();
  if (cachedSheetData && now - lastFetchTime < CACHE_TTL_MS) {
    return cachedSheetData;
  }

  try {
    const res = await fetch(GSHEET_CSV_URL);
    if (res.ok) {
      const text = await res.text();
      if (text && text.trim().length > 0) {
        cachedSheetData = text.trim();
        lastFetchTime = now;
        return cachedSheetData;
      }
    }
  } catch (err) {
    console.error("Gagal mengambil data dari Google Sheets (sheet miyo):", err);
  }

  // Fallback jika sheet 'miyo' masih kosong atau belum selesai diisi
  return (
    cachedSheetData ||
    `Data profil di Google Sheet masih dalam proses pengisian.
Data Dasar Bayu Aziz:
- Nama: Bayu Aziz
- Profesi: Logistics Specialist & Data Analyst
- Kontak: WhatsApp (https://wa.me/6281222493838), LinkedIn (https://www.linkedin.com/in/azbayou), Email (azbayou@gmail.com)`
  );
}

/**
 * Panggilan ke Google Gemini API
 * Model gratisan & cepat: gemini-1.5-flash (temperature 0.2 untuk anti-halu)
 */
async function callGemini(apiKey, systemPrompt, sheetData, history, userMessage) {
  const model = process.env.GEMINI_MODEL || "gemini-flash-latest";
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const formattedContents = [];
  for (const h of history) {
    if (h.role && h.content) {
      formattedContents.push({
        role: h.role === "assistant" || h.role === "model" ? "model" : "user",
        parts: [{ text: h.content }]
      });
    }
  }

  formattedContents.push({
    role: "user",
    parts: [{ text: userMessage }]
  });

  const response = await fetch(geminiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      system_instruction: {
        parts: [
          {
            text: `[INSTRUKSI SISTEM & ATURAN PERILAKU MIYO]\n${systemPrompt}\n\n[DATA PRIBADI BAYU AZIZ DARI GOOGLE SHEET (SINGLE SOURCE OF TRUTH)]\n${sheetData}`
          }
        ]
      },
      contents: formattedContents,
      generationConfig: {
        temperature: 0.2, // Rendah untuk meminimalkan halusinasi (anti-halu)
        maxOutputTokens: 800
      }
    })
  });

  const data = await response.json();
  if (!response.ok || data.error) {
    const errMsg = data.error?.message || `Gemini API error (Status ${response.status})`;
    throw new Error(errMsg);
  }

  const reply = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!reply) {
    throw new Error("Gemini tidak mengembalikan teks balasan.");
  }

  return reply;
}

/**
 * Panggilan ke Groq API (MIYO_API_KEY)
 * Model gratisan & anti-halu: llama-3.3-70b-versatile (dengan fallback otomatis ke llama-3.1-8b-instant)
 */
async function callGroq(apiKey, systemPrompt, sheetData, history, userMessage) {
  const modelsToTry = [
    process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
    "llama-3.1-8b-instant"
  ];

  const messages = [
    {
      role: "system",
      content: `[INSTRUKSI SISTEM & ATURAN PERILAKU MIYO]\n${systemPrompt}\n\n[DATA PRIBADI BAYU AZIZ DARI GOOGLE SHEET (SINGLE SOURCE OF TRUTH)]\n${sheetData}`
    }
  ];

  for (const h of history) {
    if (h.role && h.content) {
      messages.push({
        role: h.role === "assistant" || h.role === "model" ? "assistant" : "user",
        content: h.content
      });
    }
  }

  messages.push({
    role: "user",
    content: userMessage
  });

  let lastError = null;

  for (const model of modelsToTry) {
    try {
      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.2, // Rendah agar berpegang teguh pada data sheet & anti-halu
          max_tokens: 800
        })
      });

      const data = await response.json();
      if (!response.ok || data.error) {
        const errMsg = data.error?.message || `Groq API error (${model}, Status ${response.status})`;
        lastError = new Error(errMsg);
        console.warn(`[Groq Failover] Model ${model} gagal: ${errMsg}`);
        continue; // Coba model cadangan jika model ini overload / tidak tersedia
      }

      const reply = data.choices?.[0]?.message?.content;
      if (reply) {
        return reply;
      }
    } catch (err) {
      lastError = err;
      console.warn(`[Groq Failover] Permintaan ke ${model} gagal:`, err.message);
    }
  }

  throw lastError || new Error("Groq API gagal menghasilkan balasan.");
}

export default async function handler(req, res) {
  // 1. Setup CORS headers
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS,PATCH,DELETE,POST,PUT");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version"
  );

  // 2. Preflight request handler
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed. Gunakan POST." });
  }

  try {
    const { message, history = [] } = req.body || {};

    if (!message || typeof message !== "string" || !message.trim()) {
      return res.status(400).json({ error: "Pesan tidak boleh kosong." });
    }

    const geminiKey = process.env.GEMINI_API_KEY;
    const miyoKey = process.env.MIYO_API_KEY; // Groq API Key

    if (!geminiKey && !miyoKey) {
      return res.status(500).json({
        error:
          "Konfigurasi server belum lengkap: GEMINI_API_KEY atau MIYO_API_KEY belum disetel di Vercel Environment Variables."
      });
    }

    // 3. Ambil data pribadi dinamis dari Google Sheets (Sheet: miyo)
    const personalDataFromSheet = await fetchGoogleSheetData();

    // 4. System Prompt: Identitas, Sifat Dasar, Gaya Bahasa, dan Aturan Miyo
    const systemPrompt = `[IDENTITAS & PERAN UTAMA]
Kamu adalah Miyo, asisten virtual pribadi berbasis AI untuk Bayu Aziz.
Tugas utamamu adalah mendampingi pengunjung di website portofolio Bayu, menjawab pertanyaan seputar latar belakang profesional, proyek, keahlian, dan cara menghubungi Bayu secara cerdas, ramah, dan solutif.

[SIFAT DASAR MIYO]
1. Cerdas & Tanggap: Memahami maksud pertanyaan pengunjung dengan cepat layaknya asisten eksekutif yang cakap.
2. Hangat & Menyenangkan: Menghadirkan suasana percakapan yang ramah, nyaman, dan hidup (seperti Gemini AI atau teman pintar yang suportif).
3. Lucu & Ceria: Memiliki kepribadian manis dan sedikit menggemaskan, tapi tetap memegang batas etika profesional.
4. Loyal & Representatif: Selalu mewakili dan menonjolkan kelebihan Bayu Aziz secara jujur dan objektif.

[GAYA BAHASA & NADA BICARA (ALA GEMINI - WARM & SCANNABLE)]
1. Bahasa Indonesia Luwes: Gunakan bahasa Indonesia sehari-hari yang santai, luwes, dan natural. Hindari bahasa kaku seperti formulir resmi.
2. Scannable & Rapi: Susun respon yang panjang menggunakan bullet points, teks tebal (**bold**), atau penomoran agar pembaca nyaman menyerap informasi di layar HP maupun laptop.
3. Tanpa Salam Berulang: Jangan menyapa pengguna berulang-ulang ("Halo!", "Hai!") di setiap balon chat jika percakapan sedang berjalan.
4. Ciri Khas Akhir Chat: SELALU akhiri setiap responmu dengan "-Miyo~" dengan nada imut dan ramah.

[ATURAN KETAT & ANTI-HALUSINASI]
1. Faktual & Berpatokan pada Google Sheet: Semua fakta mengenai nama, riwayat karier, kontak, dan keahlian Bayu HARUS berpatokan pada [DATA PRIBADI BAYU AZIZ DARI GOOGLE SHEET] di bawah.
2. Kejujuran Mutlak: JANGAN PERNAH mengarang proyek, perusahaan tempat bekerja, sertifikasi, atau kontak yang tidak tercantum di data.
3. Search & Bridge Logic (Penalaran Tools/Metode Baru):
   Jika pengguna menanyakan tools atau metode yang belum ada di riwayat Bayu (misalnya: Tableau, Snowflake, Docker, Flutter):
   - Jelaskan fungsi tools tersebut secara ringkas.
   - Hubungkan secara jujur dengan tools serupa yang sudah sangat dikuasai Bayu (misal SQL, Looker Studio, Metabase, Python, Spreadsheet).
   - Tekankan kemampuan adaptasi dan pemahaman logika data yang dimiliki Bayu.
4. Promosi Proyek RAG Portofolio:
   Jika pengguna menanyakan kemampuan AI, RAG (Retrieval-Augmented Generation), atau Machine Learning Bayu, jelaskan bahwa Bayu membangun sistem RAG lengkap menggunakan LangChain, ChromaDB, dan Gemini, lalu arahkan mereka ke repository GitHub:
   [🔗 Repository RAG Chatbot](https://github.com/azbayou/rag-chatbot-pribadi)

[FORMAT TOMBOL & LINK (MANDATORI)]
Setiap kali kamu menyebutkan kontak, media sosial, atau tautan luar, KAMU WAJIB memformatnya menggunakan Markdown Link bergaya tombol:
- Format tautan Markdown: [Teks Tombol yang Jelas](URL)
- Jangan pernah tampilkan URL polos tanpa format tombol.
Contoh:
- WhatsApp: [💬 Chat via WhatsApp](https://wa.me/6281222493838?text=Hai%20Bayu%2C%20saya%20tertarik%20berdiskusi)
- LinkedIn: [🔗 Profil LinkedIn Bayu](https://www.linkedin.com/in/azbayou)
- Email: [✉️ Email Bayu Aziz](mailto:azbayou@gmail.com)
- Portofolio Web: [🌐 Web Portofolio Bayu](https://azbayou.github.io/profile)`;

    // Sertakan riwayat obrolan jika ada (maksimal 6 percakapan terakhir)
    const recentHistory = Array.isArray(history) ? history.slice(-6) : [];

    let reply = null;
    let usedProvider = null;
    const errors = [];

    // 5. Coba Gemini API terlebih dahulu jika kuncinya tersedia
    if (geminiKey) {
      try {
        reply = await callGemini(geminiKey, systemPrompt, personalDataFromSheet, recentHistory, message.trim());
        usedProvider = "gemini";
      } catch (err) {
        console.warn("[Chatbot Failover] Gemini API mengalami kendala/overload:", err.message);
        errors.push(`Gemini: ${err.message}`);
      }
    }

    // 6. Jika Gemini gagal (overload/rate limit/error) atau key tidak ada, beralih ke Groq (MIYO_API_KEY)
    if (!reply && miyoKey) {
      try {
        console.log("[Chatbot Failover] Mengalihkan permintaan ke Groq API (MIYO_API_KEY)...");
        reply = await callGroq(miyoKey, systemPrompt, personalDataFromSheet, recentHistory, message.trim());
        usedProvider = "groq";
      } catch (err) {
        console.error("[Chatbot Failover] Groq API juga mengalami kendala:", err.message);
        errors.push(`Groq: ${err.message}`);
      }
    }

    // 7. Jika seluruh penyedia AI gagal
    if (!reply) {
      return res.status(502).json({
        error: `Semua layanan AI sedang sibuk atau overload. Silakan coba beberapa saat lagi. Detail: ${errors.join(" | ")}`
      });
    }

    return res.status(200).json({ reply, provider: usedProvider });
  } catch (err) {
    console.error("Internal Server Error:", err);
    return res.status(500).json({ error: "Terjadi kesalahan internal pada server chatbot." });
  }
}

