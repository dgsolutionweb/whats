# Bot WhatsApp para Converter Vídeos do YouTube em MP3

Este bot permite que você envie links do YouTube pelo WhatsApp e receba de volta o áudio convertido em formato MP3. Ele utiliza a IA da Groq para entender solicitações em linguagem natural.

## Recursos

- Converte vídeos do YouTube para MP3
- Entende solicitações em linguagem natural usando IA da Groq
- Extrai automaticamente URLs do YouTube das mensagens
- Envia o arquivo MP3 de volta para o WhatsApp
- **Novo:** Suporte para playlists do YouTube (até 5 vídeos por vez)
- **Novo:** Limitação automática de tamanho para compatibilidade com o WhatsApp
- **Novo:** Estatísticas de uso para administradores
- **Novo:** Sistema de ajuda integrado

## Requisitos

- Node.js (v14 ou superior)
- FFmpeg instalado no sistema
- Conta Groq para obter uma API Key
- Conexão com WhatsApp

## Instalação

1. Clone este repositório:
```
git clone <url-do-repositorio>
cd whatsapp-youtube-mp3-bot
```

2. Instale as dependências:
```
npm install
```

3. Instale o FFmpeg (se ainda não estiver instalado):

Para Ubuntu/Debian:
```
sudo apt update
sudo apt install ffmpeg
```

Para macOS (usando Homebrew):
```
brew install ffmpeg
```

4. Configure as variáveis de ambiente:
   - Renomeie o arquivo `.env.example` para `.env`
   - Adicione sua chave de API da Groq: `GROQ_API_KEY=sua_chave_api_aqui`
   - (Opcional) Configure números de administradores: `ADMIN_NUMBERS=5521XXXXXXXXX,5521YYYYYYY`

## Como usar

1. Inicie o bot:
```
npm start
```

2. Escaneie o código QR que aparece no terminal usando seu WhatsApp

3. Envie uma mensagem com um link do YouTube ou uma solicitação em linguagem natural para o número conectado

4. O bot irá processar o vídeo e enviar de volta o arquivo MP3

## Comandos disponíveis

- `!ajuda` ou `ajuda` - Exibe instruções de uso do bot
- `!stats` - Mostra estatísticas de uso (apenas para administradores configurados)

## Exemplos de uso

- Envie diretamente um link do YouTube: `https://www.youtube.com/watch?v=dQw4w9WgXcQ`
- Ou uma solicitação em linguagem natural: "Converta este vídeo para mp3: https://www.youtube.com/watch?v=dQw4w9WgXcQ"
- Para playlists: "Converta esta playlist: https://www.youtube.com/playlist?list=PLH9Z5B0VL"
- Para obter ajuda: "!ajuda" ou simplesmente "ajuda"

## Limitações

- Tamanho máximo de arquivo: 15MB (limite do WhatsApp)
- Máximo de 5 vídeos por playlist
- Vídeos muito longos (mais de 30 minutos) podem não ser convertidos corretamente

## Notas

- Certifique-se de ter uma conexão estável com a internet
- O bot processa um vídeo por vez
- Vídeos muito longos podem demorar mais para serem processados
- Para acessar estatísticas, adicione seu número ao arquivo .env na variável ADMIN_NUMBERS

## Licença

ISC 