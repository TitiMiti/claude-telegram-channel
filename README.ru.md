# Claude Code в Telegram: темы, голос, отдельная сессия на каждую тему

Форк официального плагина Telegram для Claude Code (Apache-2.0, см. [NOTICE](./NOTICE)). Английская версия: [README.md](./README.md).

Что добавлено к оригиналу:

- **Темы в личном чате с ботом.** Каждая тема это отдельная сессия Claude Code со своей историей и своей рабочей папкой. Один чат с ботом работает как несколько независимых чатов.
- **Голос.** Голосовые сообщения и аудио распознаются внутри плагина через Yandex SpeechKit, в сессию приходит уже текст.
- **Менеджер сессий.** Один долгоживущий процесс читает Telegram и раскладывает сообщения по темам, поднимает сессии в tmux и продолжает разговор после перезапуска.
- **Живые черновики** («Thinking…», `stream_reply`): есть в коде, но по умолчанию выключены, так как на практике появляются с задержками.

> Статус: рабочий, но молодой. Проверялся на одном боте и одной машине. Claude Code Channels это research preview, поведение может меняться.

## Как это устроено

```
Telegram ── @ваш_бот ── manager.ts (единственный, кто читает Telegram)
                          ├─ тема «Сайт»   → сессия Claude Code в tmux, папка ~/workspace/Сайт
                          ├─ тема «Сервер» → сессия Claude Code в tmux, папка ~/workspace/Сервер
                          └─ вне тем       → сессия main, папка ~/workspace
```

Менеджер проверяет доступ (allowlist), распознаёт голос и передаёт сообщение сессии нужной темы. Каждая сессия получает лёгкий канал-MCP, который отвечает в *свою* тему и не может писать в чужие. Подробности: [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).

Есть и обычный режим «одна сессия без тем», как в оригинале (раздел «Quick Setup» в английском README).

## Что понадобится

- Linux или macOS, который работает постоянно (подойдёт VPS).
- [Bun](https://bun.sh), `tmux`, `ffmpeg` (для голоса).
- [Claude Code](https://code.claude.com) версии 2.1.80 или новее, уже авторизованный (подписка claude.ai или API-ключ Console). Каналы не работают через Bedrock, Google Cloud и Foundry. На Team и Enterprise администратор должен включить каналы.
- Токен бота от [@BotFather](https://t.me/BotFather).
- Для голоса: ключ Yandex Cloud SpeechKit (необязательно).

## Установка по шагам

### 1. Бот

В [@BotFather](https://t.me/BotFather): `/newbot`, получите токен. Чтобы работали темы: настройки бота → **Topics** (Threaded Mode) → включить. Проверить: `getMe` должен вернуть `has_topics_enabled: true`.

### 2. Код

```sh
git clone https://github.com/TitiMiti/claude-telegram-channel ~/claude-telegram-channel
cd ~/claude-telegram-channel && bun install
```

### 3. Секреты

Папка состояния по умолчанию `~/.claude/channels/telegram` (другая задаётся `TELEGRAM_STATE_DIR`; путь лучше держать коротким, там лежит unix-сокет менеджера, лимит около 104 байт).

```sh
mkdir -p ~/.claude/channels/telegram && chmod 700 ~/.claude/channels/telegram
cat > ~/.claude/channels/telegram/.env <<'ENV'
TELEGRAM_BOT_TOKEN=123456789:AAH...
YANDEX_API_KEY=AQVN...        # необязательно, только для голоса
ENV
chmod 600 ~/.claude/channels/telegram/.env
```

Токен и ключ Яндекса не попадают в окружение сессий Claude и не пишутся в логи.

### 4. Ключ Yandex SpeechKit (для голоса)

Без ключа всё работает, голосовые просто приходят без расшифровки, и бот один раз сообщит об этом.

1. В [консоли Yandex Cloud](https://console.yandex.cloud) создайте платёжный аккаунт и каталог (folder).
2. **Сервисные аккаунты** → создайте, например, `tg-stt`.
3. Откройте его → **Создать новый ключ** → **API-ключ**. Область действия: **`yc.ai.speechkitStt.execute`** и больше ничего. Скопируйте ключ (виден один раз, вид `AQVN...`).
4. Если консоль требует роль: выдайте `ai.speechkit-stt.user` сервисному аккаунту в **правах доступа каталога** (не в правах самого аккаунта: там роли `ai.*` не показываются).
5. SpeechKit тарифицируется по минутам аудио. Поставьте бюджет или оповещение о расходах в консоли.

Язык распознавания по умолчанию `ru-RU`, меняется переменной `YANDEX_LANGUAGE`. Лимит размера аудио 10 МБ.

### 5. Доступ только для вас

Узнайте свой числовой Telegram ID (например, у [@userinfobot](https://t.me/userinfobot)) и создайте `~/.claude/channels/telegram/access.json`:

```json
{ "dmPolicy": "allowlist", "allowFrom": ["123456789"], "groups": {}, "pending": {} }
```

Остальным бот не отвечает. Другой вариант: оставить `"dmPolicy": "pairing"`: бот пришлёт код, который нужно подтвердить командой `/telegram:access pair <код>` в сессии Claude Code.

### 6. Запуск менеджера

```sh
cd ~/claude-telegram-channel
bun manager.ts        # в консоли, остановка Ctrl-C
```

Как служба systemd (пользовательский юнит):

```sh
cp contrib/claude-telegram-manager.service ~/.config/systemd/user/
# отредактируйте WorkingDirectory, HOME и PATH (должны находиться bun, claude, tmux)
systemctl --user daemon-reload
systemctl --user enable --now claude-telegram-manager
journalctl --user -u claude-telegram-manager -f
```

В юните стоит `KillMode=process`, чтобы перезапуск менеджера не убивал сессии Claude в tmux.

Напишите боту. Первая сессия поднимется за 10–20 секунд.

### Установка как плагина Claude Code (одна сессия, без тем)

Если менеджер тем не нужен, поставьте форк как обычный плагин из маркетплейса этого репозитория:

```
/plugin marketplace add TitiMiti/claude-telegram-channel
/plugin install telegram@titimiti-telegram
```

Из терминала то же: `claude plugin marketplace add TitiMiti/claude-telegram-channel` и
`claude plugin install telegram@titimiti-telegram --scope user`. Затем положите токен в
`~/.claude/channels/telegram/.env`, а свой ID в `access.json` (шаги 3 и 5 выше) и запустите:

```sh
claude --dangerously-load-development-channels plugin:telegram@titimiti-telegram
```

Флаг нужен, потому что форк не входит в список разрешённых каналов Anthropic: Claude Code
просит подтверждение при каждом старте (на Team и Enterprise администратор может добавить
плагин в `allowedChannelPlugins`). Менеджеру тем установка плагина **не нужна**: он сам
подключает канал через `--mcp-config`.

**Не включайте одновременно официальный `telegram@claude-plugins-official`**: у обоих имя
`telegram`, и оба читают бота, из-за чего возникает `409 Conflict` и теряются сообщения.
Отключить: `claude plugin disable telegram@claude-plugins-official`.

## Как пользоваться

| Команда в Telegram | Что делает |
| --- | --- |
| `/new Сайт` | Создаёт тему «Сайт» и сессию Claude в `~/workspace/Сайт` (существующая папка с таким именем используется, регистр не важен). |
| `/new Инфра ~/servers/infra` | То же, но с явной рабочей папкой. |
| `/sessions` | Список сессий. |
| `/stop` | Останавливает сессию этой темы. Следующее сообщение продолжит тот же разговор. |
| `/restart` | Перезапускает сессию темы. |

- Темы, созданные в приложении Telegram, тоже работают: первое сообщение запустит сессию в `~/workspace/<имя темы>`.
- Сообщения вне тем идут в сессию `main` (папка `~/workspace`).
- Команды принимаются только от пользователей из allowlist и только в личке.
- Посмотреть сессию: `tmux -L claude-telegram attach -t tg-<id чата>-<id темы>` (выход: Ctrl-b, затем d). Все сессии: `tmux -L claude-telegram ls`, остановить все: `tmux -L claude-telegram kill-server`.

### Голос

Отправьте голосовое или аудиофайл. Claude получает текст с пометкой `voice="true"`. Рекомендуется добавить в `CLAUDE.md` сессий правило вроде: «Перед ответом одной строкой покажи, как ты понял голосовое: «🎤 <текст>». Если текст искажён, переспроси».

## Настройки

### `manager.json` (в папке состояния, все ключи необязательны)

```json
{
  "workspaceRoot": "~/workspace",
  "claudeCommand": "claude",
  "claudeArgs": [],
  "autoConfirmDevChannels": true,
  "autoCreateSessions": true,
  "mainSession": true,
  "tmuxSocket": "claude-telegram"
}
```

- `workspaceRoot`: где создаются папки тем (или `TELEGRAM_WORKSPACE_ROOT`).
- `claudeArgs`: дополнительные аргументы к `claude`. Режим без запросов разрешений включается здесь (`["--dangerously-skip-permissions"]`): **решайте осознанно**, см. раздел про безопасность.
- `autoConfirmDevChannels`: форк не входит в список разрешённых каналов Anthropic, поэтому при каждом старте Claude Code просит подтвердить загрузку development-канала. Менеджер нажимает Enter сам.
- `autoCreateSessions`: создавать сессию при первом сообщении в новой теме.

Пример: [contrib/manager.example.json](./contrib/manager.example.json).

### `access.json` (поведение бота)

Подробно в [ACCESS.md](./ACCESS.md). Из дополнений форка: `thinkingDraft` (по умолчанию `false`) и `streamReplies` (по умолчанию `false`).

### Переменные окружения

| Переменная | Значение |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Токен бота (обычно в `.env`). |
| `YANDEX_API_KEY` | Ключ SpeechKit. |
| `YANDEX_LANGUAGE` | Язык распознавания, по умолчанию `ru-RU`. |
| `YANDEX_DATA_LOGGING` | `1` отключает заголовок `x-data-logging-enabled: false` (см. ниже). |
| `TELEGRAM_STATE_DIR` | Папка состояния, по умолчанию `~/.claude/channels/telegram`. Один бот на папку. |
| `TELEGRAM_ACCESS_MODE` | `static`: читать `access.json` один раз при запуске. |
| `TELEGRAM_WORKSPACE_ROOT` | Переопределяет `workspaceRoot`. |

## Безопасность и приватность

Прочитайте до того, как подключать бота к чему-то важному.

- **Голос уходит третьей стороне.** Каждое голосовое или аудио от пользователя из allowlist отправляется в Yandex Cloud SpeechKit, обратно приходит текст. Защиты кроме HTTPS до серверов Яндекса нет: Яндекс получает и аудио, и текст. Что сделано для снижения риска: распознаются только сообщения из allowlist; результат удаляется на стороне Яндекса сразу после получения (`deleteRecognition`); запрос идёт с заголовком `x-data-logging-enabled: false` (просьба не хранить данные для улучшения сервиса; выполняет ли Яндекс эту просьбу, проверить нельзя). Не диктуйте секреты. Нет ключа: ничего никуда не отправляется.
- **Telegram видит всё.** Чаты с ботами не имеют сквозного шифрования: сообщения, файлы и голос доступны Telegram.
- **Бот это пульт управления вашей машиной.** Любой, кто может ему написать (и любой, кто получит доступ к вашему Telegram-аккаунту), заставит Claude выполнять команды от вашего пользователя. Держите `dmPolicy` в `allowlist` или `pairing`, не добавляйте группы без необходимости и запускайте бота под отдельным пользователем или в контейнере, а не под основной учёткой.
- **Prompt injection.** Тексты и файлы, которые попадают к Claude (сообщения, пересланное, веб-страницы), могут пытаться им управлять. С `--dangerously-skip-permissions` ничто не спрашивает подтверждения. Используйте этот режим только на одноразовой машине, где нет ценного (ключей к боевым серверам, облачных токенов, платёжных доступов).
- **Секреты на диске.** Токен бота и ключ Яндекса лежат в `.env` (права 0600). Выдавайте ключу Яндекса только область распознавания речи и ставьте лимит расходов.
- **Расходы.** Лимиты подписки или токены Claude API и минуты SpeechKit вы контролируете сами. Много параллельных сессий быстро расходуют лимит подписки.

## Частые проблемы

- **Диалог обрывается, в журнале `409 Conflict`.** Токен читают двое. Официальный плагин `telegram@claude-plugins-official` в тех же настройках Claude Code запускает свой поллер рядом с менеджером. Отключите его: `claude plugin disable telegram@claude-plugins-official`. На один токен должен быть один читатель: не запускайте менеджер вместе с обычной сессией `claude --channels plugin:telegram@...`.
- **Бот молчит или сессия не отвечает.** Посмотрите её экран через tmux. При первом запуске в новой папке Claude Code спрашивает «доверять папке» и подтверждение режима без запросов: менеджер сам их не подтверждает, а пришлёт в тему подсказку, как подключиться и ответить.
- **Новая тема «мёртвая»** (в неё нельзя написать): известная ошибка клиента Telegram. `/new` удалит привязку и сообщит об ошибке, создайте тему заново.
- **Сообщения до запуска сессии Claude не видит:** у Bot API нет истории.
- **В теме нет ответа после перезагрузки сервера.** Менеджер поднимет сессию при следующем сообщении и продолжит разговор (`--resume`).
- **Виджеты (`sendWidget`)** Telegram для ботов открывает постепенно. Если приходит `INPUT_MEDIA_WIDGET_NOT_ALLOWED`, функция для вашего бота ещё не включена.

## Разработка и тесты

```sh
bun install
bun test        # 72 теста: маршрутизация, SpeechKit на моках, черновики, сквозной тест менеджера с фейковым Bot API
```

С настоящим Telegram, Claude Code и SpeechKit автотесты не работают: это проверяется вручную.

## Лицензия

Apache-2.0. Основано на плагине Telegram из [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official).
