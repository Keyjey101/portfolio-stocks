# Деплой на сервер с nginx (gmyrya.com)

Приложение спроектировано под **существующий конфиг nginx без изменений**:

```
location /     → http://127.0.0.1:3000   ← страницы и статика (PORT)
location /api/ → http://127.0.0.1:3001   ← все API-роуты (API_PORT)
```

Один процесс `node dashboard.js` слушает **оба** порта на `127.0.0.1`.
HTTPS уже terminируется nginx'ом (Certbot) — приложение про SSL знать не должно.

## 1. Подготовка

```bash
# Node >= 18.14
node -v

# код на сервер (один из вариантов)
git clone <репозиторий> /opt/portfolio-terminal
# либо с рабочей машины: rsync -av --exclude .git --exclude node_modules ./ server:/opt/portfolio-terminal/

cd /opt/portfolio-terminal
cp .env.example .env
chmod 600 .env
nano .env          # ключи + обязательно APP_PASSWORD (см. ниже)
```

Минимум в `.env` для продакшена:

```
APP_PASSWORD=<длинный пароль, openssl rand -base64 18>
HOST=127.0.0.1
PORT=3000
API_PORT=3001
TRADERNET_PUBLIC_KEY=...
TRADERNET_PRIVATE_KEY=...
ZAI_API_KEY=...
LLM_DAILY_LIMIT=300
```

`data/` (журнал решений, прогнозы, кэши) переносится вместе с проектом или
начинается пустым — всё пересоздастся.

## 2. Освободить порты и поставить systemd

Старый сервис на 3001 остановить: `systemctl stop <старый> && systemctl disable <старый>`.

`/etc/systemd/system/portfolio-terminal.service`:

```ini
[Unit]
Description=Портфельный терминал (dashboard.js)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/portfolio-terminal
Environment=HOST=127.0.0.1
Environment=PORT=3000
Environment=API_PORT=3001
ExecStart=/usr/bin/node dashboard.js
Restart=always
RestartSec=3
User=www-data
# data/ должна принадлежать сервис-пользователю (журнал и кэши пишутся туда)
# chown -R www-data:www-data /opt/portfolio-terminal/data

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now portfolio-terminal
journalctl -u portfolio-terminal -f     # смотрим лог старта
```

## 3. Проверка

```bash
curl -s localhost:3000/api/session    # {"ok":true,"owner":false,"auth":true}
curl -s localhost:3001/api/session    # то же — API-порт жив
curl -s https://gmyrya.com/api/session
```

В браузере: гость видит проценты/вердикты, сумм нет; 🔑 в шапке → вход →
полные данные и кнопки агентов. nginx перезагружать не нужно.

### 3a. Исходящий трафик: до чего серверу надо дотягиваться

VPN на сервере не нужен — но дата-центр должен напрямую видеть источники
данных. Проверка перед деплоем (с самого сервера):

```bash
curl -s -m 8 -o /dev/null -w "yahoo  %{http_code} за %{time_total}s\n" \
  "https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&range=1mo"
curl -s -m 8 -o /dev/null -w "z.ai   %{http_code} за %{time_total}s\n" https://api.z.ai/
curl -s -m 8 -o /dev/null -w "tradernet %{http_code} за %{time_total}s\n" https://freedom24.com/
curl -s -m 8 -o /dev/null -w "fred   %{http_code} за %{time_total}s\n" https://fred.stlouisfed.org/
```

Ожидаемо: yahoo `200`, fred `200`; 429 от yahoo — «подожди, лимит»
(не страшно, но повтори через минуту); **таймаут/000 — источник недоступен**.

Если что-то недоступно, приложение не падает и не виснет — деградирует
по цепочке (живые данные → память 25 с → диск `data/cache/data.json`):

| Источник недоступен | Что видит пользователь |
|---|---|
| Yahoo | последние успешные данные + честная ошибка «рынок недоступен» вместо висения |
| Tradernet | позиции из кэша `data/positions.json` (метка «позиции — кэш»); если и брокер нужен живьём — `TRADERNET_PROXY` в `.env` |
| z.ai | кнопки агентов отвечают ошибкой, остальное работает |
| FRED / NewsAPI | соответствующие полосы на дашборде скрываются |

Единственный реальный риск на VPS: Yahoo режет IP-адреса дата-центров
(429 на каждый запрос). Приложение вежливо к нему обращается (6 параллельно,
пауза 250 мс, кэш 25 с / календарь 6 ч), но если лимит стойкий — выход:
другой хостер/егресс или явный `TRADERNET_PROXY`-подобный релей для Yahoo.

## 4. Модель доступа (что защищено)

| | Гость (без пароля) | Владелец (🔑 → APP_PASSWORD) |
|---|---|---|
| Вердикты, проценты, уровни, факторная модель, календарь | да | да |
| Точные суммы: qty, цена входа, стоимость позиций, кэш, итог | **вырезаются на сервере** | да |
| Монте-Карло (личный план), журнал решений | **401** | да |
| Кнопки агентов (комитет, фальсификации, базовые ставки, `?force=1`) | **401** | да |

Защита — на сервере (не «спрятать в CSS»): санитизация ответа `/api/data`
и проверка каждого мутационного роута.

## 5. Предохранители

- **Rate limit** (в памяти, на IP из `X-Real-IP`): 90 обычных GET/мин,
  12 тяжёлых (POST/`force=1`/`backfill`) в мин → 429.
- **Подбор пароля**: 8 попыток / 5 мин с одного IP → 403.
- **Бюджет z.ai**: `LLM_DAILY_LIMIT` вызовов в сутки (счётчик `data/cache/llm-budget.json`),
  превышение — понятная ошибка вместо счёта за LLM.
- **Cookie**: подписанный HMAC-токен, 30 дней, HttpOnly + SameSite=Lax;
  `Secure` ставится автоматически за HTTPS-nginx. Смена `APP_PASSWORD`
  мгновенно завершает все сессии.
- Порты слушаются только на `127.0.0.1` — снаружи напрямую не достучаться,
  только через nginx.

## 6. Бэкап

Живое (не восстанавливается из внешних источников):

```
data/decisions.jsonl  data/predictions.jsonl  data/recs.jsonl
data/falsifications.json  data/journal-snapshot.json  data/llm-log.jsonl
data/capcycle/history.json
```

Раз в день: `tar czf backup-$(date +%F).tgz data/*.json* data/capcycle`.

## Заметки

- Фоновые пересчёты (планировщик) идут в основном процессе: пока сервис
  работает, кэши лаборатории греются сами по расписанию.
- Автопоиск локального прокси для Tradernet на сервере не сработает и не нужен:
  если брокер напрямую недоступен с VPS — задай `TRADERNET_PROXY` явно.
- Обновление кода: `git pull && systemctl restart portfolio-terminal`.
