const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const ytDlp = require('yt-dlp-exec');
const { Groq } = require('groq-sdk');
const { MercadoPagoConfig, Payment } = require('mercadopago');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
require('dotenv').config();

// Definir ambiente de desenvolvimento se não estiver configurado
process.env.NODE_ENV = process.env.NODE_ENV || 'development';
console.log(`Ambiente: ${process.env.NODE_ENV}`);

// Configuração do cliente Groq
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

// Configuração do Mercado Pago
const mercadopagoClient = new MercadoPagoConfig({
  accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN
});
const paymentClient = new Payment(mercadopagoClient);

// Configuração do cliente WhatsApp
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    args: ['--no-sandbox'],
  }
});

// Pasta para os arquivos temporários
const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir);
}

// Pasta para armazenar dados
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir);
}

// Arquivo de dados para assinaturas e estatísticas
const subscriptionsFile = path.join(dataDir, 'subscriptions.json');
const statsFile = path.join(dataDir, 'stats.json');
const paymentsFile = path.join(dataDir, 'payments.json');

// Limites e configurações
const MAX_FILE_SIZE_MB = 15; // Tamanho máximo em MB que o WhatsApp suporta
const MAX_PLAYLIST_ITEMS = 5; // Número máximo de vídeos em uma playlist
const SUBSCRIPTION_PRICE = 10; // Preço da assinatura mensal em reais

// Estatísticas de uso
const stats = {
  totalConversions: 0,
  totalUsers: new Set(),
  userUsage: {},
  errors: 0,
  lastError: null,
  dailyUsage: {},
  payments: {
    total: 0,
    successful: 0,
    failed: 0
  }
};

// Sistema de assinaturas
const subscriptions = {};

// Sistema de pagamentos pendentes
const pendingPayments = {};

// Números de administradores do bot
const adminNumbers = process.env.ADMIN_NUMBERS ? process.env.ADMIN_NUMBERS.split(',').map(num => normalizePhoneNumber(num)) : [];

// Função para normalizar números de telefone
function normalizePhoneNumber(phone) {
  // Remove qualquer caractere que não seja dígito
  let normalized = phone.replace(/\D/g, '');
  
  // Se for um número completo com código do país, garante que esteja sem o "+" inicial
  if (normalized.startsWith('55')) {
    return normalized;
  }
  
  // Adiciona código do Brasil se não estiver presente
  if (!normalized.startsWith('55')) {
    normalized = '55' + normalized;
  }
  
  return normalized;
}

// Função para verificar se o usuário tem assinatura ativa
function hasActiveSubscription(userId) {
  if (!subscriptions[userId]) {
    return false;
  }
  
  const today = new Date();
  const expiryDate = new Date(subscriptions[userId].expiresAt);
  
  if (today > expiryDate) {
    // Assinatura expirada
    delete subscriptions[userId];
    return false;
  }
  
  return true;
}

// Carregar dados salvos
function loadSavedData() {
  try {
    // Carregar assinaturas
    if (fs.existsSync(subscriptionsFile)) {
      const data = fs.readFileSync(subscriptionsFile, 'utf8');
      Object.assign(subscriptions, JSON.parse(data));
      console.log(`Carregadas ${Object.keys(subscriptions).length} assinaturas do arquivo`);
    }
    
    // Carregar estatísticas
    if (fs.existsSync(statsFile)) {
      const data = fs.readFileSync(statsFile, 'utf8');
      const loadedStats = JSON.parse(data);
      
      // Restaurar propriedades primitivas
      stats.totalConversions = loadedStats.totalConversions || 0;
      stats.errors = loadedStats.errors || 0;
      stats.lastError = loadedStats.lastError || null;
      
      // Restaurar totalUsers como Set
      stats.totalUsers = new Set(loadedStats.totalUsers || []);
      
      // Restaurar outras propriedades
      stats.userUsage = loadedStats.userUsage || {};
      stats.dailyUsage = loadedStats.dailyUsage || {};
      stats.payments = loadedStats.payments || { total: 0, successful: 0, failed: 0 };
      
      console.log('Estatísticas carregadas do arquivo');
    }
    
    // Carregar pagamentos pendentes
    if (fs.existsSync(paymentsFile)) {
      const data = fs.readFileSync(paymentsFile, 'utf8');
      const loadedPayments = JSON.parse(data);
      
      // Converter strings de data de volta para objetos Date
      for (const userId in loadedPayments) {
        if (loadedPayments[userId].created_at) {
          loadedPayments[userId].created_at = new Date(loadedPayments[userId].created_at);
        }
      }
      
      Object.assign(pendingPayments, loadedPayments);
      console.log(`Carregados ${Object.keys(pendingPayments).length} pagamentos pendentes do arquivo`);
    }
  } catch (error) {
    console.error('Erro ao carregar dados salvos:', error);
  }
}

// Salvar dados periodicamente
function saveData() {
  try {
    // Salvar assinaturas
    fs.writeFileSync(subscriptionsFile, JSON.stringify(subscriptions, null, 2));
    
    // Preparar estatísticas para salvar (converter Set para Array)
    const statsToSave = {
      ...stats,
      totalUsers: Array.from(stats.totalUsers)
    };
    
    // Salvar estatísticas
    fs.writeFileSync(statsFile, JSON.stringify(statsToSave, null, 2));
    
    // Salvar pagamentos pendentes
    fs.writeFileSync(paymentsFile, JSON.stringify(pendingPayments, null, 2));
    
    console.log('Dados salvos com sucesso');
  } catch (error) {
    console.error('Erro ao salvar dados:', error);
  }
}

// Carregar dados ao iniciar
loadSavedData();

// Salvar dados a cada 10 minutos e ao encerrar
setInterval(saveData, 10 * 60 * 1000);
process.on('SIGINT', () => {
  console.log('Salvando dados antes de encerrar...');
  saveData();
  process.exit();
});

// Evento de QR Code
client.on('qr', (qr) => {
  console.log('QR RECEBIDO, escaneie com o WhatsApp!');
  qrcode.generate(qr, { small: true });
});

// Evento de login
client.on('ready', () => {
  console.log('Cliente WhatsApp conectado!');
});

// Função para verificar se uma URL é uma playlist
function isPlaylistUrl(url) {
  return url.includes('playlist?list=') || url.includes('&list=');
}

// Função para extrair o ID da playlist
function extractPlaylistId(url) {
  const regex = /[&?]list=([^&]+)/;
  const match = url.match(regex);
  return match ? match[1] : null;
}

// Função para obter informações da playlist
async function getPlaylistInfo(url) {
  try {
    const info = await ytDlp(url, {
      flatPlaylist: true,
      dumpSingleJson: true,
      noCheckCertificate: true,
      noWarnings: true,
      preferFreeFormats: true,
      addHeader: [
        'referer:youtube.com',
        'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      ]
    });

    // Limitar o número de vídeos a serem baixados
    info.entries = info.entries.slice(0, MAX_PLAYLIST_ITEMS);
    
    return info;
  } catch (error) {
    console.error('Erro ao obter informações da playlist:', error);
    throw error;
  }
}

// Função para obter informações do vídeo
async function getVideoInfo(url) {
  try {
    const info = await ytDlp(url, {
      dumpSingleJson: true,
      noCheckCertificate: true,
      noWarnings: true,
      preferFreeFormats: true,
      addHeader: [
        'referer:youtube.com',
        'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      ]
    });
    
    // Nota: Não rejeitamos mais baseado no tamanho estimado, pois pode ser impreciso
    // Vamos tentar converter e comprimir se necessário
    console.log(`Informações do vídeo: Título: ${info.title}, Duração: ${info.duration}s, Tamanho estimado: ${Math.round((info.filesize_approx || 0) / (1024 * 1024))}MB`);
    
    return {
      title: info.title,
      id: extractVideoId(url),
      duration: info.duration,
      filesize: info.filesize_approx || 0
    };
  } catch (error) {
    console.error('Erro ao obter informações do vídeo:', error);
    throw error;
  }
}

// Função para comprimir MP3 usando ffmpeg
async function compressMP3(inputPath, outputPath, bitrate = '64k') {
  try {
    console.log(`Comprimindo arquivo MP3 com FFmpeg para bitrate ${bitrate}...`);
    
    // Nome do arquivo temporário
    const tempOutputPath = `${inputPath}.compressed.mp3`;
    
    // Comando ffmpeg para comprimir o arquivo
    const command = `ffmpeg -y -i "${inputPath}" -c:a libmp3lame -b:a ${bitrate} "${tempOutputPath}"`;
    
    // Executar o comando
    await execPromise(command);
    
    // Verificar se o arquivo existe
    if (fs.existsSync(tempOutputPath)) {
      // Mover o arquivo comprimido para o destino final
      fs.renameSync(tempOutputPath, outputPath);
      
      const originalSize = Math.round(fs.statSync(inputPath).size / (1024 * 1024));
      const compressedSize = Math.round(fs.statSync(outputPath).size / (1024 * 1024));
      console.log(`Compressão concluída: Tamanho original: ${originalSize}MB, Tamanho comprimido: ${compressedSize}MB`);
      
      // Remover o arquivo original
      fs.unlinkSync(inputPath);
      
      return outputPath;
    } else {
      throw new Error('Falha ao comprimir o arquivo MP3 com FFmpeg');
    }
  } catch (error) {
    console.error('Erro ao comprimir MP3 com FFmpeg:', error);
    throw error;
  }
}

// Função para converter URL do YouTube para MP3 usando yt-dlp
async function convertYoutubeToMp3(url, outputPath, quality = 0) {
  return new Promise(async (resolve, reject) => {
    const videoId = extractVideoId(url);
    
    try {
      // Primeira tentativa com a qualidade solicitada
      console.log(`Convertendo vídeo ${videoId} com qualidade de áudio: ${quality}`);
      
      // Opções para o yt-dlp
      const options = {
        extractAudio: true,
        audioFormat: 'mp3',
        audioQuality: quality, // 0 é a melhor, 9 é a pior
        output: outputPath,
        noCheckCertificate: true,
        noWarnings: true,
        preferFreeFormats: true,
        addHeader: [
          'referer:youtube.com',
          'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        ],
        progress: true // Habilitar informações de progresso
      };
      
      await ytDlp(url, options);
      
      // Verificar se o arquivo é muito grande
      const fileStats = fs.statSync(outputPath);
      console.log(`Arquivo convertido: ${outputPath}, Tamanho: ${Math.round(fileStats.size / (1024 * 1024))}MB`);
      
      // Se o arquivo for grande demais e ainda não estamos na qualidade mais baixa, tente novamente
      if (fileStats.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
        if (quality < 9) {
          console.log(`Arquivo muito grande (${Math.round(fileStats.size / (1024 * 1024))}MB). Tentando novamente com qualidade reduzida.`);
          
          // Remover o arquivo grande
          fs.unlinkSync(outputPath);
          
          // Tentar novamente com qualidade mais baixa
          const newQuality = Math.min(9, quality + 3);
          
          // Chamada recursiva com qualidade mais baixa
          return convertYoutubeToMp3(url, outputPath, newQuality)
            .then(resolve)
            .catch(reject);
        } else {
          // Estamos na qualidade mais baixa e ainda é grande demais
          // Última tentativa: comprimir com FFmpeg
          try {
            console.log(`Arquivo ainda grande demais na qualidade mais baixa. Tentando compressão com FFmpeg...`);
            
            // Criar um arquivo temporário para comprimir
            const tempFile = `${outputPath}.temp.mp3`;
            fs.renameSync(outputPath, tempFile);
            
            // Comprimir usando FFmpeg com bitrate baixo
            await compressMP3(tempFile, outputPath, '48k');
            
            // Verificar o tamanho final
            const newFileStats = fs.statSync(outputPath);
            console.log(`Após compressão FFmpeg: ${Math.round(newFileStats.size / (1024 * 1024))}MB`);
            
            // Se ainda for grande demais, tentar uma compressão ainda mais extrema
            if (newFileStats.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
              console.log(`Ainda grande demais. Última tentativa com bitrate mínimo...`);
              
              // Renomear para novo arquivo temporário
              const tempFile2 = `${outputPath}.final.mp3`;
              fs.renameSync(outputPath, tempFile2);
              
              // Comprimir com bitrate muito baixo
              await compressMP3(tempFile2, outputPath, '32k');
            }
            
            // Verificar o tamanho final após todas as compressões
            const finalFileStats = fs.statSync(outputPath);
            console.log(`Tamanho final após todas as compressões: ${Math.round(finalFileStats.size / (1024 * 1024))}MB`);
            
            resolve(outputPath);
          } catch (ffmpegError) {
            console.error('Erro na compressão FFmpeg:', ffmpegError);
            // Se falhar na compressão FFmpeg, continua com o arquivo original
            resolve(outputPath);
          }
        }
      } else {
        console.log('Conversão finalizada com sucesso');
        resolve(outputPath);
      }
    } catch (err) {
      console.error('Erro durante a conversão:', err);
      reject(err);
    }
  });
}

// Extrai o ID do vídeo da URL
function extractVideoId(url) {
  if (url.includes('youtu.be/')) {
    return url.split('youtu.be/')[1].split('?')[0];
  } else if (url.includes('youtube.com/watch?v=')) {
    return url.split('v=')[1].split('&')[0];
  } else {
    return 'video';
  }
}

// Verificar se a URL é do YouTube
function isYoutubeUrl(url) {
  return url.includes('youtube.com/') || url.includes('youtu.be/');
}

// Usar Groq para analisar a mensagem e verificar intenções
async function analyzeMessage(text) {
  try {
    const completion = await groq.chat.completions.create({
      messages: [
        {
          role: "system",
          content: "Você é um assistente descolado e divertido que ajuda a converter vídeos do YouTube em MP3. Use uma linguagem jovem, informal e brasileira, com gírias como 'mano', 'cara', 'massa', 'top', 'da hora'. Abrevie palavras como 'tá', 'tô', 'pra'. Use muitos emojis e seja entusiasmado. \n\n" +
          "Se o texto do usuário mencionar algo sobre converter vídeo ou áudio do YouTube, peça educadamente que ele envie a URL do vídeo. \n\n" +
          "Se o usuário pedir ajuda ou fizer alguma pergunta sobre como usar o sistema, explique de forma descontraída que ele precisa enviar um link do YouTube para você converter em MP3. \n\n" +
          "Importante: NÃO finja ter encontrado uma URL quando não há nenhuma. Apenas oriente o usuário a enviar um link válido do YouTube. Nunca diga 'Encontrei uma URL' se não houver link do YouTube na mensagem. \n\n" +
          "Se o usuário enviar uma saudação simples como 'olá', 'oi', responda de forma animada e explique que você pode converter vídeos do YouTube em MP3. \n\n" +
          "Use uma linguagem bem descontraída como se fosse um jovem brasileiro conversando com amigos."
        },
        {
          role: "user",
          content: text
        }
      ],
      model: "llama3-8b-8192",
      temperature: 0.7,
      max_tokens: 1000
    });

    return completion.choices[0].message.content;
  } catch (error) {
    console.error('Erro ao analisar mensagem com Groq:', error);
    return 'Eita, deu ruim! 😅 Tive um probleminha técnico aqui. Manda de novo aí, por favor?';
  }
}

// Extrair URL do YouTube da mensagem
function extractYoutubeUrl(text) {
  // Regex mais rigorosa para evitar falsos positivos
  const urlRegex = /(https?:\/\/)?(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/)[a-zA-Z0-9_-]+([^\s]*)/;
  const match = text.match(urlRegex);
  
  // Verificação adicional para confirmar que é realmente uma URL do YouTube
  if (match && match[0]) {
    const possibleUrl = match[0];
    // Verificar se a URL contém pelo menos um domínio do YouTube
    if (possibleUrl.includes('youtube.com') || possibleUrl.includes('youtu.be')) {
      console.log('URL do YouTube detectada:', possibleUrl);
      return possibleUrl;
    }
  }
  
  return null;
}

// Exibir mensagem de ajuda
function getHelpMessage() {
  return `🔥 *Bot YouTube pra MP3* 🎵

*Como usar, é mamão com açúcar:*
1️⃣ Manda o link do YouTube aí (vídeo ou playlist)
2️⃣ Relaxa que tô processando...
3️⃣ Pega teu MP3 na hora! 🤙

*Comandos top:*
• !ajuda - Te explico tudo de novo
• !stats - Mostra as estatísticas (só pros admin)
• !assinar - Informações sobre a assinatura premium
• !pix - Gera um QR Code para pagamento via PIX
• !verificar - Verifica o status do seu pagamento
• !status - Veja o status da sua assinatura

*Plano Premium - Apenas R$${SUBSCRIPTION_PRICE}/mês:*
• Downloads ilimitados 🚀
• Suporte a playlists (até ${MAX_PLAYLIST_ITEMS} vídeos) 🎧
• Prioridade no processamento ⚡
• Suporte personalizado 👑

*Plano Gratuito:*
• 5 conversões por dia
• Máximo 2 vídeos por playlist

*Limitações (é o jeito, né):*
• Arquivo até ${MAX_FILE_SIZE_MB}MB (culpa do WhatsApp 🙄)
• Máximo ${MAX_PLAYLIST_ITEMS} vídeos por playlist

Feito pela DGSolutionWEB, tá voando! 🚀

Se precisar de algum suporte clique aqui: https://wa.me/5517999754390`;
}

// Obter estatísticas de uso
function getStatsMessage() {
  return `📊 *Estatísticas do Bot - Tá bombando!* 🔥

• Conversões: ${stats.totalConversions} (tá voando! 🚀)
• Galera usando: ${stats.totalUsers.size} pessoas
• Bugs: ${stats.errors} (até que tô aguentando bem 😎)
• Último erro: ${stats.lastError || 'Zero! Tamo bem demais'}

*Pagamentos:*
• Total de pagamentos: ${stats.payments.total}
• Pagamentos aprovados: ${stats.payments.successful}
• Pagamentos falhos: ${stats.payments.failed}
• Taxa de aprovação: ${stats.payments.total > 0 ? Math.round((stats.payments.successful / stats.payments.total) * 100) : 0}%

*Galera que mais usa:*
${Object.entries(stats.userUsage)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 5)
  .map(([number, count], index) => {
    // Formata o número para exibição
    const formattedNumber = number.includes('@') 
      ? `${number.split('@')[0].slice(-4)}` 
      : `${number.slice(-4)}`;
    const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '🏅';
    const isPremium = hasActiveSubscription(number) ? ' 💎' : '';
    return `${medal} ${formattedNumber}${isPremium}: ${count} conversões`;
  })
  .join('\n')}`;
}

// Função para obter informações de assinatura
function getSubscriptionMessage() {
  return `💎 *Assinatura Premium - R$${SUBSCRIPTION_PRICE}/mês* 💎

Com nosso plano premium, você pode:
• Converter quantos vídeos quiser, sem limites! 🚀
• Baixar playlists inteiras de uma vez! 🎧
• Prioridade no processamento! ⏱️
• Atendimento VIP! 👑

Para assinar, é super simples:
1️⃣ Digite !pix para gerar um QR Code de pagamento
2️⃣ Pague o valor de R$${SUBSCRIPTION_PRICE} usando o PIX
3️⃣ Sua assinatura será ativada automaticamente!

Sua assinatura ficará ativa por 30 dias após a confirmação do pagamento! 🔓

Dúvidas? Só mandar !ajuda que te respondo rapidinho! 😉`;
}

// Gerar QR Code PIX usando Mercado Pago
async function generatePixQRCode(userId, messageObj = null) {
  try {
    // Verificar se o token está configurado
    if (!process.env.MERCADOPAGO_ACCESS_TOKEN) {
      throw new Error("Token de acesso do Mercado Pago não configurado");
    }
    
    // Log para debug
    console.log("Tentando criar pagamento PIX com Mercado Pago...");
    
    // Gerar ID de referência único para este pagamento
    const paymentId = `BOT_${userId}_${Date.now()}`;
    
    // Configurar detalhes do pagamento conforme documentação atual
    const payment_data = {
      transaction_amount: SUBSCRIPTION_PRICE,
      description: process.env.PIX_DESCRIPTION || "Assinatura Premium do Bot YouTube MP3",
      payment_method_id: "pix",
      payer: {
        email: "cliente@exemplo.com",
        first_name: "Usuario",
        last_name: "WhatsApp",
        identification: {
          type: "CPF",
          number: "19119119100"
        }
      },
      external_reference: paymentId
    };
    
    console.log("Dados do pagamento:", JSON.stringify(payment_data));
    
    try {
      // Criar pagamento no Mercado Pago
      const payment = await paymentClient.create({ body: payment_data });
      
      console.log("Resposta do Mercado Pago:", JSON.stringify(payment));
      
      // Tentar encontrar as informações do QR code em diferentes locais possíveis na resposta
      let qrCode, qrCodeText, paymentResponseId;
      
      console.log("Estrutura da resposta:", Object.keys(payment).join(", "));
      
      // Imprimir a resposta completa para depuração
      console.log("Resposta completa:", JSON.stringify(payment, null, 2));
      
      // Nova abordagem para extrair os dados do QR code
      if (payment.id) {
        console.log("Detectado formato direto (SDK 2.3.0)");
        paymentResponseId = payment.id;
        
        // Verificar se os dados do ponto de interação estão disponíveis diretamente
        if (payment.point_of_interaction && payment.point_of_interaction.transaction_data) {
          console.log("Extraindo dados diretamente do objeto payment");
          qrCode = payment.point_of_interaction.transaction_data.qr_code_base64;
          qrCodeText = payment.point_of_interaction.transaction_data.qr_code;
          console.log("QR code extraído com sucesso do objeto principal");
        }
      }
      
      // Abordagem de fallback para versões anteriores do SDK
      if (!paymentResponseId || !qrCodeText) {
        // Verificar estrutura aninhada em response
        if (payment.response) {
          paymentResponseId = paymentResponseId || payment.response.id;
          console.log("point_of_interaction existe?", !!payment.response.point_of_interaction);
          
          if (payment.response.point_of_interaction && 
              payment.response.point_of_interaction.transaction_data) {
            console.log("transaction_data existe?", !!payment.response.point_of_interaction.transaction_data);
            console.log("Campos em transaction_data:", Object.keys(payment.response.point_of_interaction.transaction_data).join(", "));
            
            qrCode = qrCode || payment.response.point_of_interaction.transaction_data.qr_code_base64;
            qrCodeText = qrCodeText || payment.response.point_of_interaction.transaction_data.qr_code;
          } 
          // Se não encontrou no caminho esperado, tente outros caminhos possíveis
          else if (payment.response.transaction_details && 
                  payment.response.transaction_details.external_resource_url) {
            qrCodeText = qrCodeText || payment.response.transaction_details.external_resource_url;
          }
        } 
        // Verificar estrutura de data (outro formato possível)
        else if (payment.data) {
          paymentResponseId = paymentResponseId || payment.data.id;
          
          if (payment.data.point_of_interaction && 
              payment.data.point_of_interaction.transaction_data) {
            qrCode = qrCode || payment.data.point_of_interaction.transaction_data.qr_code_base64;
            qrCodeText = qrCodeText || payment.data.point_of_interaction.transaction_data.qr_code;
          }
        }
      }
      
      // Se ainda não encontrou, tente procurar em toda a estrutura usando busca recursiva
      if (!qrCodeText || !qrCode) {
        console.log("Procurando QR code em toda a estrutura usando busca recursiva...");
        // Função para procurar recursivamente na estrutura de resposta
        function findInObject(obj, key) {
          if (!obj || typeof obj !== 'object') return null;
          
          if (obj[key] !== undefined) return obj[key];
          
          for (const k in obj) {
            if (typeof obj[k] === 'object') {
              const found = findInObject(obj[k], key);
              if (found !== null) return found;
            }
          }
          
          return null;
        }
        
        qrCodeText = qrCodeText || findInObject(payment, 'qr_code');
        qrCode = qrCode || findInObject(payment, 'qr_code_base64');
        
        // Se ainda não encontrou o ID
        if (!paymentResponseId) {
          paymentResponseId = findInObject(payment, 'id');
        }
        
        console.log("Resultado da busca recursiva - ID:", paymentResponseId);
        console.log("Resultado da busca recursiva - QR code text:", qrCodeText ? "Encontrado" : "Não encontrado");
        console.log("Resultado da busca recursiva - QR code base64:", qrCode ? "Encontrado" : "Não encontrado");
      }
      
      if (!paymentResponseId) {
        console.warn("⚠️ ID do pagamento não encontrado na resposta, mas continuando em modo de desenvolvimento...");
        // Em vez de lançar um erro, vamos continuar apenas em modo de desenvolvimento
        if (process.env.NODE_ENV !== 'development') {
          throw new Error("ID do pagamento não encontrado na resposta");
        }
        paymentResponseId = "DEV_" + Date.now();
      }
      
      if (!qrCodeText) {
        console.warn("⚠️ QR Code do PIX não encontrado na resposta, mas continuando em modo de desenvolvimento...");
        // Em vez de lançar um erro, vamos continuar apenas em modo de desenvolvimento
        if (process.env.NODE_ENV !== 'development') {
          throw new Error("QR Code do PIX não encontrado na resposta");
        }
        qrCodeText = "PIX_SIMULADO_" + Date.now();
      }
      
      console.log("Pagamento criado com sucesso, ID:", paymentResponseId);

      // No desenvolvimento, se não tivermos os dados completos, vamos ativar diretamente a assinatura
      if (process.env.NODE_ENV === 'development' && (!qrCode || !qrCodeText)) {
        console.log("Ativando assinatura diretamente em modo de desenvolvimento");
        const expiryDate = activateSubscription(userId, true);
        
        // Se temos um objeto de mensagem, enviar confirmação
        if (messageObj) {
          messageObj.reply(`✅ *Assinatura Premium Ativada em Modo Desenvolvimento* ✅

Sua assinatura foi ativada automaticamente porque estamos em ambiente de desenvolvimento!

• Válida até: ${expiryDate}
• Status: ATIVO ✓

Aproveite todos os recursos premium:
• Downloads ilimitados
• Conversão de playlists
• Prioridade no processamento

Nota: Em produção, será necessário o pagamento via PIX.`);
        }
      }
      
      // Armazenar o pagamento pendente para verificação posterior
      pendingPayments[userId] = {
        id: paymentResponseId,
        external_reference: paymentId,
        created_at: new Date(),
        amount: SUBSCRIPTION_PRICE,
        status: "pending"
      };
      
      // Retornar dados do pagamento PIX
      return {
        qrCode: qrCode || "",  // Pode ser vazio se só tivermos o texto
        qrCodeText: qrCodeText,
        paymentId: paymentResponseId
      };
      
    } catch (mpError) {
      console.error("Erro específico do Mercado Pago:", JSON.stringify(mpError, null, 2));
      
      // Tentar extrair informações detalhadas do erro
      let errorDetail = "Erro desconhecido";
      
      if (mpError.cause) {
        console.error("Causa do erro:", JSON.stringify(mpError.cause, null, 2));
      }
      
      if (mpError.response && mpError.response.data) {
        console.error("Detalhes do erro:", JSON.stringify(mpError.response.data, null, 2));
        if (mpError.response.data.message) {
          errorDetail = mpError.response.data.message;
        } else if (mpError.response.data.error) {
          errorDetail = mpError.response.data.error;
        }
      }
      
      // Exibir todas as propriedades do objeto de erro para depuração
      console.error("Todas as propriedades do erro:", Object.keys(mpError));
      
      throw new Error(`Erro ao processar pagamento no Mercado Pago: ${errorDetail}`);
    }
  } catch (error) {
    console.error("Erro ao gerar QR Code PIX:", error);
    
    // Mensagem mais detalhada para o desenvolvedor
    if (error.status === 403) {
      console.error("Erro de autorização: Verifique se seu token do Mercado Pago tem permissões para criar pagamentos.");
      console.error("1. Verifique se está usando um token de produção (não de sandbox)");
      console.error("2. Verifique se sua conta está habilitada para receber pagamentos via PIX");
      console.error("3. O token precisa ter scope para criar pagamentos");
    }
    
    // Para simplificar durante o desenvolvimento, vamos ativar a assinatura diretamente
    if (process.env.NODE_ENV === 'development') {
      console.log("Modo de desenvolvimento: Ativando assinatura sem pagamento");
      const expiryDate = activateSubscription(userId, true);
      
      // Se temos um objeto de mensagem, enviar confirmação
      if (messageObj) {
        messageObj.reply(`✅ *Assinatura Premium Ativada em Modo Desenvolvimento* ✅

Sua assinatura foi ativada automaticamente porque estamos em ambiente de desenvolvimento!

• Válida até: ${expiryDate}
• Status: ATIVO ✓

Aproveite todos os recursos premium:
• Downloads ilimitados
• Conversão de playlists
• Prioridade no processamento

Nota: Em produção, será necessário o pagamento via PIX.`);
      }
      
      throw new Error(`Falha ao gerar PIX, mas assinatura ativada no modo de desenvolvimento até ${expiryDate}`);
    }
    
    throw error;
  }
}

// Verificar status de um pagamento
async function checkPaymentStatus(paymentId) {
  try {
    console.log(`Verificando status do pagamento ${paymentId}...`);
    const response = await paymentClient.get({ id: paymentId });
    
    console.log("Resposta bruta do status do pagamento:", JSON.stringify(response, null, 2));
    
    // Imprimir as chaves de primeiro nível para depuração
    console.log("Estrutura da resposta:", Object.keys(response).join(", "));
    
    // Verificar estrutura da resposta baseada na versão do SDK Mercado Pago
    let status = null;
    
    // Abordagem 1: Acesso direto na V2.3.0+
    if (response.status) {
      console.log("Encontrou status diretamente:", response.status);
      status = response.status;
    } 
    // Abordagem 2: Estrutura aninhada em versões anteriores
    else if (response.response && response.response.status) {
      console.log("Encontrou status em response.response:", response.response.status);
      status = response.response.status;
    }
    // Abordagem 3: Busca recursiva
    else {
      console.log("Buscando status recursivamente na estrutura de resposta");
      
      function findInObject(obj, key) {
        if (!obj || typeof obj !== 'object') return null;
        
        if (obj[key] !== undefined) return obj[key];
        
        for (const k in obj) {
          if (typeof obj[k] === 'object') {
            const found = findInObject(obj[k], key);
            if (found !== null) return found;
          }
        }
        
        return null;
      }
      
      status = findInObject(response, 'status');
      console.log("Status encontrado por busca recursiva:", status);
    }
    
    // Log final do status encontrado
    if (status) {
      console.log(`Status do pagamento ${paymentId}: ${status}`);
      return status;
    } else {
      console.warn(`Não foi possível determinar o status do pagamento ${paymentId}`);
      return "unknown";
    }
  } catch (error) {
    console.error("Erro ao verificar status do pagamento:", error);
    
    // Exibir detalhes do erro para depuração
    if (error.response) {
      console.error("Detalhes do erro:", JSON.stringify(error.response.data || error.response, null, 2));
    }
    
    return "error";
  }
}

// Verificar pagamentos pendentes periodicamente
async function checkPendingPayments() {
  console.log("Verificando pagamentos pendentes...");
  console.log(`Total de pagamentos pendentes: ${Object.keys(pendingPayments).length}`);
  
  for (const userId in pendingPayments) {
    const payment = pendingPayments[userId];
    console.log(`Verificando pagamento para usuário ${userId}, ID: ${payment.id}, status atual: ${payment.status}`);
    
    // Verificar pagamentos criados há menos de 24 horas
    const paymentAge = (new Date() - new Date(payment.created_at)) / (1000 * 60 * 60);
    console.log(`Idade do pagamento: ${paymentAge.toFixed(2)} horas`);
    
    if (paymentAge < 24 && payment.status === "pending") {
      console.log(`Consultando API para pagamento ${payment.id}...`);
      const status = await checkPaymentStatus(payment.id);
      console.log(`Status retornado pela API: ${status}`);
      
      if (status === "approved") {
        // Verificar se o pagamento já foi processado anteriormente
        if (pendingPayments[userId].status === "approved") {
          console.log(`Pagamento ${payment.id} já foi processado anteriormente, ignorando`);
        } else {
          console.log(`Pagamento ${payment.id} APROVADO! Ativando assinatura para ${userId}`);
          // Pagamento aprovado pela primeira vez, ativar assinatura
          const expiryDate = activateSubscription(userId);
          pendingPayments[userId].status = "approved";
          stats.payments.successful++;
          
          // Notificar o usuário sobre o pagamento aprovado
          try {
            await client.sendMessage(`${userId}@c.us`, `✅ *Pagamento Aprovado!* ✅

Recebemos seu pagamento de R$${SUBSCRIPTION_PRICE} e sua assinatura premium foi ativada!

• Válida até: ${expiryDate}
• Status: ATIVO ✓

Aproveite todos os recursos premium:
• Downloads ilimitados
• Conversão de playlists
• Prioridade no processamento

Obrigado por assinar! 🚀`);
          } catch (error) {
            console.error("Erro ao notificar usuário sobre pagamento:", error);
          }
        }
      } else if (status === "rejected" || status === "cancelled") {
        console.log(`Pagamento ${payment.id} ${status === "rejected" ? "Rejeitado" : "Cancelado"}! Notificando usuário ${userId}`);
        // Pagamento rejeitado ou cancelado
        pendingPayments[userId].status = status;
        stats.payments.failed++;
        
        // Notificar o usuário sobre o problema
        try {
          await client.sendMessage(`${userId}@c.us`, `❌ *Pagamento ${status === "rejected" ? "Rejeitado" : "Cancelado"}* ❌

Infelizmente seu pagamento não foi concluído.

Você pode tentar novamente digitando !pix para gerar um novo QR code.

Precisa de ajuda? Digite !ajuda para falar com um administrador.`);
        } catch (error) {
          console.error("Erro ao notificar usuário sobre pagamento:", error);
        }
      } else if (status === "unknown" || status === "error") {
        console.log(`Pagamento ${payment.id} retornou status ${status}, mantendo como pendente para nova verificação futura`);
        // Não alterar o status para permitir nova verificação
      } else {
        console.log(`Pagamento ${payment.id} retornou status ${status}, que não foi tratado especificamente`);
        // Para outros status, registrar mas não tomar ação
        pendingPayments[userId].lastChecked = new Date().toISOString();
      }
    } else if (payment.status !== "pending") {
      console.log(`Pagamento ${payment.id} já processado (${payment.status}), ignorando`);
    } else {
      console.log(`Pagamento ${payment.id} muito antigo (${paymentAge.toFixed(2)}h), será excluído`);
    }
  }

  // Limpar pagamentos antigos (mais de 24h)
  for (const userId in pendingPayments) {
    const payment = pendingPayments[userId];
    const paymentAge = (new Date() - new Date(payment.created_at)) / (1000 * 60 * 60);
    if (paymentAge >= 24) {
      console.log(`Removendo pagamento antigo: ${payment.id} (${paymentAge.toFixed(2)}h)`);
      delete pendingPayments[userId];
    }
  }
  
  // Salvar dados após verificação
  saveData();
  
  console.log("Verificação de pagamentos concluída");
}

// Verificar pagamentos a cada 5 minutos
setInterval(checkPendingPayments, 5 * 60 * 1000);

// Evento de mensagem
client.on('message', async (message) => {
  try {
    const text = message.body;
    const sender = message.from;
    const normalizedSender = normalizePhoneNumber(sender);
    
    console.log(`Mensagem recebida de ${sender} (normalizado: ${normalizedSender}): ${text}`);
    
    // Verificar se é uma primeira mensagem (saudação)
    const isSaudacao = /^(oi|olá|ola|bom dia|boa tarde|boa noite|eae|e ai|salve|fala|alô|alo|hi|hello|hey|start|comecar|começar|iniciar)[\s!?.]*$/i.test(text);
    
    if (isSaudacao) {
      const hora = new Date().getHours();
      let saudacao = '';
      
      if (hora >= 5 && hora < 12) {
        saudacao = 'Bom dia';
      } else if (hora >= 12 && hora < 18) {
        saudacao = 'Boa tarde';
      } else {
        saudacao = 'Boa noite';
      }
      
      const mensagemInicial = `${saudacao}, beleza? 🤙 Tô aqui pra te ajudar a baixar áudios do YouTube! 🎵

Manda aí o link do vídeo que você quer converter pra MP3! 🔥

Se precisar de uma ajudinha, só mandar "!ajuda" que te explico melhor! 😉`;
      
      await message.reply(mensagemInicial);
      return;
    }
    
    // Registrar o usuário nas estatísticas
    stats.totalUsers.add(normalizedSender);
    if (!stats.userUsage[normalizedSender]) {
      stats.userUsage[normalizedSender] = 0;
    }
    
    // Comandos especiais - Processar antes da análise da IA
    // Comando de ajuda
    if (text === '!ajuda' || text.toLowerCase() === 'ajuda' || text.toLowerCase() === 'help') {
      await message.reply(getHelpMessage());
      return;
    }
    
    // Comando de estatísticas
    if (text === '!stats') {
      console.log(`Comando de estatísticas recebido de ${normalizedSender}`);
      console.log(`Administradores configurados: ${adminNumbers.join(', ')}`);
      
      const isAdmin = adminNumbers.some(admin => normalizedSender.includes(admin) || admin.includes(normalizedSender));
      
      if (isAdmin) {
        console.log(`Usuário ${normalizedSender} autorizado como administrador`);
        await message.reply(getStatsMessage());
      } else {
        console.log(`Usuário ${normalizedSender} não autorizado como administrador`);
        await message.reply('⛔ Acesso negado, mano! Só os admin podem ver isso... 😜');
      }
      return;
    }
    
    // Comando para informações sobre assinatura
    if (text === '!assinar' || text.toLowerCase() === 'assinar') {
      await message.reply(getSubscriptionMessage());
      return;
    }
    
    // Comando para gerar PIX
    if (text === '!pix') {
      try {
        await message.reply('⏳ Gerando QR Code PIX para assinatura...');
        
        // Se estivermos em modo de desenvolvimento e houver erro no Mercado Pago, ofereça a opção de simular pagamento
        if (process.env.NODE_ENV === 'development') {
          try {
            const pixData = await generatePixQRCode(normalizedSender, message);
            
            try {
              // Tentar gerar imagem do QR Code e enviar
              if (pixData.qrCode) {
                const qrBuffer = Buffer.from(pixData.qrCode, 'base64');
                fs.writeFileSync(path.join(tempDir, `pix_${normalizedSender}.png`), qrBuffer);
                
                const media = MessageMedia.fromFilePath(path.join(tempDir, `pix_${normalizedSender}.png`));
                
                await message.reply(media, undefined, { 
                  caption: `🔒 *Assinatura Premium - R$${SUBSCRIPTION_PRICE}/mês* 🔒

Escaneie o QR Code acima para fazer o pagamento via PIX.

Ou copie o código PIX abaixo:
\`\`\`${pixData.qrCodeText}\`\`\`

Após o pagamento, sua assinatura será ativada automaticamente em até 5 minutos!

ID do Pagamento: ${pixData.paymentId}` 
                });
                
                // Limpar o arquivo temporário
                fs.unlinkSync(path.join(tempDir, `pix_${normalizedSender}.png`));
              } else {
                // Se não tiver QR code em base64, enviar só o texto
                await message.reply(`🔒 *Assinatura Premium - R$${SUBSCRIPTION_PRICE}/mês* 🔒

Copie o código PIX abaixo para fazer o pagamento:
\`\`\`${pixData.qrCodeText}\`\`\`

Após o pagamento, sua assinatura será ativada automaticamente em até 5 minutos!

ID do Pagamento: ${pixData.paymentId}`);
              }
              
              stats.payments.total++;
              
            } catch (imageError) {
              console.error('Erro ao gerar imagem do QR code:', imageError);
              
              // Enviar apenas o texto do PIX caso a geração de imagem falhe
              await message.reply(`🔒 *Assinatura Premium - R$${SUBSCRIPTION_PRICE}/mês* 🔒

Não foi possível gerar a imagem QR Code, mas você pode copiar o código PIX abaixo:
\`\`\`${pixData.qrCodeText}\`\`\`

Após o pagamento, sua assinatura será ativada automaticamente em até 5 minutos!

ID do Pagamento: ${pixData.paymentId}`);
              
              stats.payments.total++;
            }
          } catch (error) {
            console.error('Erro ao gerar PIX:', error);
            await message.reply(`❌ Não foi possível gerar o QR Code PIX. Erro: ${error.message}\n\nEstamos em ambiente de desenvolvimento, você pode digitar !simular_pagamento para ativar a assinatura para testes.`);
            return;
          }
        } else {
          try {
            const pixData = await generatePixQRCode(normalizedSender, message);
            
            // Gerar imagem do QR Code e enviar
            const qrBuffer = Buffer.from(pixData.qrCode, 'base64');
            fs.writeFileSync(path.join(tempDir, `pix_${normalizedSender}.png`), qrBuffer);
            
            const media = MessageMedia.fromFilePath(path.join(tempDir, `pix_${normalizedSender}.png`));
            
            await message.reply(media, undefined, { 
              caption: `🔒 *Assinatura Premium - R$${SUBSCRIPTION_PRICE}/mês* 🔒

Escaneie o QR Code acima para fazer o pagamento via PIX.

Ou copie o código PIX abaixo:
\`\`\`${pixData.qrCodeText}\`\`\`

Após o pagamento, sua assinatura será ativada automaticamente em até 5 minutos!

ID do Pagamento: ${pixData.paymentId}` 
            });
            
            // Limpar o arquivo temporário
            fs.unlinkSync(path.join(tempDir, `pix_${normalizedSender}.png`));
            
            stats.payments.total++;
            
          } catch (error) {
            console.error('Erro ao gerar PIX:', error);
            await message.reply('❌ Não foi possível gerar o QR Code PIX. Por favor, tente novamente mais tarde ou entre em contato com o administrador.');
          }
        }
      } catch (error) {
        console.error('Erro ao gerar PIX:', error);
        await message.reply('❌ Não foi possível gerar o QR Code PIX. Por favor, tente novamente mais tarde ou entre em contato com o administrador.');
      }
      return;
    }
    
    // Comando para verificar pagamento manualmente
    if (text === '!verificar') {
      if (pendingPayments[normalizedSender]) {
        await message.reply('⏳ Verificando seu pagamento...');
        
        const paymentId = pendingPayments[normalizedSender].id;
        const paymentDate = new Date(pendingPayments[normalizedSender].created_at).toLocaleString('pt-BR');
        const status = await checkPaymentStatus(paymentId);
        
        console.log(`Usuário ${normalizedSender} verificou pagamento ${paymentId}, status: ${status}`);
        
        if (status === "approved") {
          // Verificar se o pagamento já foi processado anteriormente
          if (pendingPayments[normalizedSender].status === "approved") {
            // Se já foi aprovado, apenas exibe a mensagem sem ativar a assinatura novamente
            const expiryDate = subscriptions[normalizedSender] ? 
              new Date(subscriptions[normalizedSender].expiresAt).toLocaleDateString('pt-BR') : 
              'Data não encontrada';
            
            await message.reply(`✅ *Pagamento Já Aprovado* ✅

Seu pagamento já foi processado anteriormente.

• Válida até: ${expiryDate}
• Status: ATIVO ✓

Aproveite todos os recursos premium:
• Downloads ilimitados
• Conversão de playlists
• Prioridade no processamento`);
          } else {
            // Pagamento aprovado pela primeira vez, ativar assinatura
            const expiryDate = activateSubscription(normalizedSender);
            pendingPayments[normalizedSender].status = "approved";
            stats.payments.successful++;
            
            await message.reply(`✅ *Pagamento Aprovado!* ✅

Recebemos seu pagamento de R$${SUBSCRIPTION_PRICE} e sua assinatura premium foi ativada!

• Válida até: ${expiryDate}
• Status: ATIVO ✓

Aproveite todos os recursos premium:
• Downloads ilimitados
• Conversão de playlists
• Prioridade no processamento

Obrigado por assinar! 🚀`);
          }
        } else if (status === "pending") {
          await message.reply(`⏳ *Pagamento Pendente* ⏳

Ainda não recebemos a confirmação do seu pagamento.

Se você já pagou, aguarde alguns minutos para o processamento.
O sistema verifica automaticamente a cada 5 minutos.

• ID do Pagamento: ${paymentId}
• Data da geração: ${paymentDate}
• Status atual: Pendente

Se já se passaram mais de 15 minutos desde o pagamento, 
digite !pix para gerar um novo código.`);
          
        } else if (status === "unknown" || status === "error") {
          await message.reply(`⚠️ *Verificação de Pagamento em Andamento* ⚠️

Estamos com dificuldades técnicas para consultar o status do seu pagamento.

• ID do Pagamento: ${paymentId}
• Data da geração: ${paymentDate}
• Status atual: Em verificação

O sistema continuará tentando verificar automaticamente.
Se você já realizou o pagamento, ele será processado em breve.

Se preferir, digite !pix para gerar um novo código de pagamento.`);

        } else {
          await message.reply(`❌ *Pagamento ${status === "rejected" ? "Rejeitado" : status === "cancelled" ? "Cancelado" : "Não Processado"}* ❌

Infelizmente seu pagamento não foi concluído.

• ID do Pagamento: ${paymentId}
• Data da geração: ${paymentDate}
• Status: ${status}

Você pode tentar novamente digitando !pix para gerar um novo QR code.

Precisa de ajuda? Digite !ajuda para falar com um administrador.`);
        }
      } else {
        // Verificar se tem assinatura ativa
        if (hasActiveSubscription(normalizedSender)) {
          const expiryDate = new Date(subscriptions[normalizedSender].expiresAt).toLocaleDateString('pt-BR');
          await message.reply(`💎 *Assinatura Premium Ativa* 💎

Você já possui uma assinatura premium válida!

• Válida até: ${expiryDate}
• Status: ATIVO ✓

Aproveite todos os recursos premium:
• Downloads ilimitados
• Conversão de playlists
• Prioridade no processamento`);
        } else {
          await message.reply('❓ *Nenhum pagamento pendente encontrado* ❓\n\nDigite !pix para gerar um novo código de pagamento.');
        }
      }
      return;
    }
    
    // Se a mensagem contém uma URL do YouTube, converter diretamente
    const youtubeUrl = extractYoutubeUrl(text);
    
    if (youtubeUrl) {
      // Verificação final para garantir que é uma URL válida do YouTube
      if (!youtubeUrl.includes('youtube.com/watch?v=') && !youtubeUrl.includes('youtu.be/')) {
        console.log('URL detectada, mas não parece ser um vídeo do YouTube válido:', youtubeUrl);
        // Não é uma URL de vídeo válida, vamos usar a IA para responder
        const analysis = await analyzeMessage(text);
        await message.reply(analysis);
        return;
      }
       
      // Verificar limite de uso - apenas se não tem assinatura e já usou no dia de hoje
      const isSubscriber = hasActiveSubscription(normalizedSender);
      
      // Verificar se o usuário já usou o serviço hoje e informar sobre sua assinatura
      if (isSubscriber) {
        await message.reply(`💎 *Usuário Premium Detectado!* 💎
Sua assinatura está ativa. Aproveite conversões ilimitadas! 🚀`);
      } else {
        // Verificar limites diários para usuários gratuitos (5 conversões por dia)
        const today = new Date().toLocaleDateString();
        if (!stats.dailyUsage) {
          stats.dailyUsage = {};
        }
        
        if (!stats.dailyUsage[today]) {
          stats.dailyUsage[today] = {};
        }
        
        if (!stats.dailyUsage[today][normalizedSender]) {
          stats.dailyUsage[today][normalizedSender] = 0;
        }
        
        // Mostrar quantidade de conversões restantes
        const usedToday = stats.dailyUsage[today][normalizedSender];
        const remainingToday = 5 - usedToday;
        
        await message.reply(`📊 *Modo Gratuito* 📊
Você tem ${remainingToday} conversões restantes hoje.

💡 Quer conversões ilimitadas? Digite !assinar`);
        
        if (usedToday >= 5) {
          await message.reply(`🔒 *Limite diário atingido!* 🔒

Você já converteu 5 vídeos hoje, que é o limite do plano gratuito.

Quer converter mais? Assine nosso plano premium por apenas R$${SUBSCRIPTION_PRICE}/mês e tenha:
• Conversões ilimitadas 🚀
• Acesso a playlists completas 🎧
• E muito mais!

Digite !assinar para saber como começar! 💎`);
          return;
        }
      }
      
      try {
        // Verificar se é uma playlist
        if (isPlaylistUrl(youtubeUrl)) {
          // Se não tem assinatura, limitar a 2 vídeos da playlist
          const maxVideos = hasActiveSubscription(normalizedSender) ? MAX_PLAYLIST_ITEMS : 2;
          
          if (!hasActiveSubscription(normalizedSender)) {
            await message.reply(`🔄 Playlist detectada! No plano gratuito você pode baixar até 2 vídeos. 
            
💡 Para baixar playlists completas, assine o plano premium por apenas R$${SUBSCRIPTION_PRICE}/mês! Digite !assinar para saber mais.`);
          } else {
            await message.reply(`🔥 Playlist detectada! Vou baixar até ${MAX_PLAYLIST_ITEMS} vídeos pra você. Já tô no corre, aguenta aí... ⏳`);
          }
          
          const playlistInfo = await getPlaylistInfo(youtubeUrl);
          
          // Limitar o número de vídeos para usuários gratuitos
          const entries = hasActiveSubscription(normalizedSender) 
            ? playlistInfo.entries.slice(0, MAX_PLAYLIST_ITEMS) 
            : playlistInfo.entries.slice(0, 2);
          
          await message.reply(`📋 Playlist: *${playlistInfo.title}*\n📊 Baixando ${entries.length} de ${playlistInfo.playlist_count} vídeos${hasActiveSubscription(normalizedSender) ? '' : ' (limite do plano gratuito)'}, tamo junto! 💪`);
          
          // Processar cada vídeo da playlist
          for (let i = 0; i < entries.length; i++) {
            const video = entries[i];
            const videoUrl = `https://www.youtube.com/watch?v=${video.id}`;
            
            try {
              await message.reply(`⏳ Processando vídeo ${i+1}/${entries.length}: ${video.title}`);
              
              const outputPath = path.join(tempDir, `${video.id}.mp3`);
              
              // Converter o vídeo para MP3
              await convertYoutubeToMp3(videoUrl, outputPath);
              
              // Verificar se o arquivo existe e não é muito grande
              if (fs.existsSync(outputPath)) {
                const fileStats = fs.statSync(outputPath);
                if (fileStats.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
                  // Se após todas as tentativas o arquivo ainda for grande demais
                  fs.unlinkSync(outputPath); // Remover o arquivo para não ocupar espaço
                  await message.reply(`⚠️ Mesmo após compressão, o arquivo de "${video.title}" ficou maior que ${MAX_FILE_SIZE_MB}MB (${Math.round(fileStats.size / (1024 * 1024))}MB). O WhatsApp tem esse limite!`);
                  continue; // Pular para o próximo vídeo
                }
                
                // Enviar o arquivo MP3
                const media = MessageMedia.fromFilePath(outputPath);
                await message.reply(media, undefined, { caption: `🎧 *${video.title}*\n\nTá na mão! 🔥` });
                
                // Limpar o arquivo temporário
                fs.unlinkSync(outputPath);
                
                // Atualizar estatísticas
                stats.totalConversions++;
                stats.userUsage[normalizedSender]++;
                
                // Incrementar uso diário para usuários não premium
                if (!hasActiveSubscription(normalizedSender)) {
                  const today = new Date().toLocaleDateString();
                  stats.dailyUsage[today][normalizedSender]++;
                }
              } else {
                throw new Error(`Não foi possível gerar o arquivo de áudio para "${video.title}".`);
              }
            } catch (error) {
              console.error(`Erro ao processar vídeo ${video.id} da playlist:`, error);
              await message.reply(`❌ Deu ruim no vídeo ${i+1}: "${video.title}". Vou tentar o próximo! 🏃‍♂️`);
              
              // Registrar o erro
              stats.errors++;
              stats.lastError = error.message;
            }
          }
          
          await message.reply('✅ Playlist concluída! Tá tudo aí, aproveita! 🎧');
        } else {
          // Processar vídeo único
          await message.reply('⏳ Já tô convertendo seu vídeo, coisa linda! Só um minutinho...');
          
          // Obter informações do vídeo
          const videoInfo = await getVideoInfo(youtubeUrl);
          const videoTitle = videoInfo.title.replace(/[^\w\s]/gi, '');
          const videoId = videoInfo.id;
          
          // Verificar duração do vídeo
          if (videoInfo.duration > 1800) { // 30 minutos
            await message.reply('⚠️ Eita, esse vídeo é grandão! (mais de 30 minutos) Vou tentar, mas se der ruim não me xinga, tá? 😅');
          }
          
          const outputPath = path.join(tempDir, `${videoId}.mp3`);
          
          // Converter o vídeo para MP3
          await convertYoutubeToMp3(youtubeUrl, outputPath);
          
          // Verificar o tamanho do arquivo final
          if (fs.existsSync(outputPath)) {
            const fileStats = fs.statSync(outputPath);
            if (fileStats.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
              // Se após todas as tentativas o arquivo ainda for grande demais
              fs.unlinkSync(outputPath); // Remover o arquivo para não ocupar espaço
              throw new Error(`Mesmo após compressão, o arquivo ficou maior que ${MAX_FILE_SIZE_MB}MB (${Math.round(fileStats.size / (1024 * 1024))}MB). O WhatsApp tem esse limite!`);
            }
            
            // Enviar o arquivo MP3
            const media = MessageMedia.fromFilePath(outputPath);
            await message.reply(media, undefined, { caption: `🎵 ${videoTitle}` });
            
            fs.unlinkSync(outputPath);
            
            // Atualizar estatísticas
            stats.totalConversions++;
            stats.userUsage[normalizedSender]++;
            
            // Incrementar uso diário para usuários não premium
            if (!hasActiveSubscription(normalizedSender)) {
              const today = new Date().toLocaleDateString();
              stats.dailyUsage[today][normalizedSender]++;
            }
          } else {
            throw new Error("Não foi possível gerar o arquivo de áudio.");
          }
        }
      } catch (error) {
        console.error('Erro ao processar o vídeo:', error);
        
        // Mensagem de erro mais amigável e informativa
        let errorMsg = '❌ Putz, deu ruim! ';
        
        if (error.message.includes('tamanho') || error.message.includes('grande')) {
          errorMsg += 'Arquivo muito grande pro WhatsApp aguentar. O bicho é fraco! 😅 Tentei comprimir de várias formas, mas não deu certo. Tenta um vídeo menor ou música mais curta!';
        } else if (error.message.includes('Copyright') || error.message.includes('copyright')) {
          errorMsg += 'Esse vídeo tá com copyright, os caras não deixam baixar. 🚫';
        } else {
          errorMsg += 'Não consegui converter. Manda outro link aí, esse tá osso! 🤔';
        }
        
        await message.reply(errorMsg);
        
        // Registrar o erro
        stats.errors++;
        stats.lastError = error.message;
      }
    } else {
      // Se não houver URL, usar a IA da Groq para entender a intenção
      // Verificar novamente se a mensagem já foi tratada como saudação para evitar processamento duplicado
      if (isSaudacao) {
        // Se já tratamos como saudação no início da função, não precisamos processar novamente
        console.log(`Mensagem já tratada como saudação: ${text}`);
        return;
      }
      
      const analysis = await analyzeMessage(text);
      
      // Verificar se a análise encontrou uma URL
      const urlFromAnalysis = extractYoutubeUrl(analysis);
      
      if (urlFromAnalysis) {
        // Verificação adicional para garantir que não é um falso positivo
        // Se o link não tiver sido enviado pelo usuário, não tentar processar
        if (!text.includes(urlFromAnalysis) && 
            !text.includes('youtube.com') && 
            !text.includes('youtu.be')) {
          console.log('URL encontrada na análise, mas não estava na mensagem original do usuário:', urlFromAnalysis);
          await message.reply(analysis);
          return;
        }
        
        // Se a IA encontrou uma URL, processá-la
        try {
          await message.reply('⏳ Achei um link do YouTube na sua mensagem! Já tô pegando pra você... 🚀');
          
          // Verificar se é uma playlist
          if (isPlaylistUrl(urlFromAnalysis)) {
            await message.reply(`🔥 Playlist detectada! Vou baixar até ${MAX_PLAYLIST_ITEMS} vídeos pra você. Já tô no corre, aguenta aí... ⏳`);
            
            const playlistInfo = await getPlaylistInfo(urlFromAnalysis);
            await message.reply(`📋 Playlist: *${playlistInfo.title}*\n📊 Baixando ${playlistInfo.entries.length} de ${playlistInfo.playlist_count} vídeos, tamo junto! 💪`);
            
            // Processar cada vídeo da playlist
            for (let i = 0; i < playlistInfo.entries.length; i++) {
              const video = playlistInfo.entries[i];
              const videoUrl = `https://www.youtube.com/watch?v=${video.id}`;
              
              try {
                await message.reply(`⏳ Processando vídeo ${i+1}/${playlistInfo.entries.length}: ${video.title}`);
                
                const outputPath = path.join(tempDir, `${video.id}.mp3`);
                
                // Converter o vídeo para MP3
                await convertYoutubeToMp3(videoUrl, outputPath);
                
                // Verificar se o arquivo existe e não é muito grande
                if (fs.existsSync(outputPath)) {
                  const fileStats = fs.statSync(outputPath);
                  if (fileStats.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
                    // Se após todas as tentativas o arquivo ainda for grande demais
                    fs.unlinkSync(outputPath); // Remover o arquivo para não ocupar espaço
                    await message.reply(`⚠️ Mesmo após compressão, o arquivo de "${video.title}" ficou maior que ${MAX_FILE_SIZE_MB}MB (${Math.round(fileStats.size / (1024 * 1024))}MB). O WhatsApp tem esse limite!`);
                    continue; // Pular para o próximo vídeo
                  }
                  
                  // Enviar o arquivo MP3
                  const media = MessageMedia.fromFilePath(outputPath);
                  await message.reply(media, undefined, { caption: `🎧 *${video.title}*\n\nTá na mão! 🔥` });
                  
                  // Limpar o arquivo temporário
                  fs.unlinkSync(outputPath);
                  
                  // Atualizar estatísticas
                  stats.totalConversions++;
                  stats.userUsage[normalizedSender]++;
                  
                  // Incrementar uso diário para usuários não premium
                  if (!hasActiveSubscription(normalizedSender)) {
                    const today = new Date().toLocaleDateString();
                    stats.dailyUsage[today][normalizedSender]++;
                  }
                } else {
                  throw new Error(`Não foi possível gerar o arquivo de áudio para "${video.title}".`);
                }
              } catch (error) {
                console.error(`Erro ao processar vídeo ${video.id} da playlist:`, error);
                await message.reply(`❌ Deu ruim no vídeo ${i+1}: "${video.title}". Vou tentar o próximo! 🏃‍♂️`);
                
                // Registrar o erro
                stats.errors++;
                stats.lastError = `Playlist item ${i+1}: ${error.message}`;
              }
            }
            
            await message.reply('✅ Playlist concluída! Tá tudo aí, aproveita! 🎧');
          } else {
            // Processar vídeo único
            // Obter informações do vídeo
            const videoInfo = await getVideoInfo(urlFromAnalysis);
            const videoTitle = videoInfo.title.replace(/[^\w\s]/gi, '');
            const videoId = videoInfo.id;
            
            // Verificar duração do vídeo
            if (videoInfo.duration > 1800) { // 30 minutos
              await message.reply('⚠️ Eita, esse vídeo é grandão! (mais de 30 minutos) Vou tentar, mas se der ruim não me xinga, tá? 😅');
            }
            
            const outputPath = path.join(tempDir, `${videoId}.mp3`);
            
            await convertYoutubeToMp3(urlFromAnalysis, outputPath);
            
            // Verificar o tamanho do arquivo final
            const fileStats = fs.statSync(outputPath);
            if (fileStats.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
              // Se após todas as tentativas o arquivo ainda for grande demais
              fs.unlinkSync(outputPath); // Remover o arquivo para não ocupar espaço
              throw new Error(`Mesmo após compressão, o arquivo ficou maior que ${MAX_FILE_SIZE_MB}MB (${Math.round(fileStats.size / (1024 * 1024))}MB). O WhatsApp tem esse limite!`);
            }
            
            const media = MessageMedia.fromFilePath(outputPath);
            await message.reply(media, undefined, { caption: `🎵 ${videoTitle}` });
            
            fs.unlinkSync(outputPath);
            
            // Atualizar estatísticas
            stats.totalConversions++;
            stats.userUsage[normalizedSender]++;
            
            // Incrementar uso diário para usuários não premium
            if (!hasActiveSubscription(normalizedSender)) {
              const today = new Date().toLocaleDateString();
              stats.dailyUsage[today][normalizedSender]++;
            }
          }
        } catch (error) {
          console.error('Erro ao processar o vídeo:', error);
          
          // Mensagem de erro mais amigável e informativa
          let errorMsg = '❌ Putz, deu ruim! ';
          
          if (error.message.includes('tamanho') || error.message.includes('grande')) {
            errorMsg += 'Arquivo muito grande pro WhatsApp aguentar. O bicho é fraco! 😅 Tentei comprimir de várias formas, mas não deu certo. Tenta um vídeo menor ou música mais curta!';
          } else if (error.message.includes('Copyright') || error.message.includes('copyright')) {
            errorMsg += 'Esse vídeo tá com copyright, os caras não deixam baixar. 🚫';
          } else {
            errorMsg += 'Não consegui converter. Manda outro link aí, esse tá osso! 🤔';
          }
          
          await message.reply(errorMsg);
          
          // Registrar o erro
          stats.errors++;
          stats.lastError = error.message;
        }
      } else {
        // Se não encontrou URL, responder com a análise da IA
        await message.reply(analysis);
      }
    }
  } catch (error) {
    console.error('Erro geral ao processar a mensagem:', error);
    
    // Registrar o erro
    stats.errors++;
    stats.lastError = error.message;
    
    // Notificar o usuário
    await message.reply('❌ Eita, deu um bug sinistro aqui! 😱 Tenta de novo mais tarde ou manda "!ajuda" que eu te explico como me usar direitinho! 😉');
  }
});

// Função para ativar uma assinatura por 30 dias
function activateSubscription(userId, adminCommand = false) {
  const today = new Date();
  let expiryDate;
  
  // Se já tem assinatura, estende por mais 30 dias
  if (subscriptions[userId] && hasActiveSubscription(userId)) {
    expiryDate = new Date(subscriptions[userId].expiresAt);
    expiryDate.setDate(expiryDate.getDate() + 30);
  } else {
    expiryDate = new Date();
    expiryDate.setDate(today.getDate() + 30);
  }
  
  subscriptions[userId] = {
    active: true,
    expiresAt: expiryDate.toISOString(),
    activatedBy: adminCommand ? 'admin' : 'payment',
    activatedAt: today.toISOString()
  };
  
  // Salvar os dados após ativação
  saveData();
  
  return expiryDate.toLocaleDateString('pt-BR');
}

// Iniciar o cliente
client.initialize(); 