# 07. Фронтенд: страницы, поведение, дизайн-интеграция

Две страницы. Фреймворк в оригинале — Vue 3 + Pinia + vue-i18n; всё ниже
фреймворко-независимо (для React заменить Pinia-стор на любой state-менеджер).

## 7.1. Страница «Анализ акции» (`/stock-analysis?ticker=…`)

### Форма
- Вкладки **Equity / Dividend**; поле тикера (maxlength 10, uppercase); кнопка
  Analyze (spinner при загрузке); при наличии результата — кнопки Reset и
  «Скопировать результат».
- Строка ошибки; опционально BiasAlert (см. §7.6).
- Прогресс-бар на время загрузки: метка текущего шага (`step_<id>` из i18n),
  ETA (`~2m 13s`), ожидаемое время окончания (часы), % — механика в §7.5.
- Кэш-баннер после результата: hit → «результат из кэша, истекает HH:MM»;
  miss → «свежий до HH:MM»; кнопка «Обновить» (force).

### Секции результата Equity (порядок сверху вниз)

| # | Секция | Поля (пути от корня результата) |
|---|---|---|
| 1 | **Вердикт-баннер** | `ticker, name`, чип `financial_metrics.cyclicality_tag`, `decision.verdict`, чипы `decision.confidence_pct`, `decision.time_horizon`, `decision.total_score/100`; справа цена; при `valuation.no_estimate` или вердикте `No Decision` — вместо MoS/Base показывается диапазон `valuation.range_low…range_high`; иначе `valuation.margin_of_safety_pct` и `valuation.dcf_base` |
| 2 | Баннер деградации | `agents_failed > 0` → предупреждение «N агентов упало» |
| 3 | Event-флаги | `event_flags.stale_filing` (красный), `.active_ma_offer` (синий), `.unexplained_move` (серый, с % за 90 дней) |
| 4 | Дисклеймер | юридическая строка «не ИИР» |
| 5 | **5 карточек скора** | `decision.component_scores.{business_quality, financial_strength, growth, valuation, risk}` (X/100 + бар); детali: moat-тип+`business_analysis.business_score`; ROIC + FCF-годы; `revenue_cagr_3y`+тренд; MoS+`valuation.valuation_score/10`; mispricing+горизонт |
| 6 | **Инвестиционный тезис** | `risk_thesis.why_cheap_or_expensive`, тег `mispricing_type`, `what_market_misses`, `thesis_summary`, списки `catalysts[]`, `key_risks[]` |
| 7 | **Оценка** | при no-estimate — пунктирный блок «нет надёжной точечной оценки»: диапазон + `valuation_framing`; иначе 3 карточки `dcf_bear/dcf_base/dcf_bull` с вероятностями 25/50/75%; абзац `valuation_framing`; полоса `expected_value` + MoS; чипы методов `valuation_methods[{name,value,weight}]`; строки деталей: EPV, цель аналитиков (+PV), WACC/рост/терминальный рост, `dcf_assumptions`, `relative_assessment`, пометка `is_cyclically_adjusted`, warning при `data_quality ≠ ok` |
| 8 | Бизнес и ров | `business_analysis.business_model, revenue_type, moat_type (чип с цветом), industry_trend, moat_description, key_insights[]` |
| 9 | Сетка фин. метрик (15 плиток) | `revenue_cagr_3y`+тренд, `avg_roic`+тренд, `avg_operating_margin`+тренд, FCF-годы, `avg_debt_ebitda`, `piotroski_f/9`, `pe_trailing`, `pe_forward` (+чип `eps_quality_flag`), trailing/forward EPS, `ev_ebitda`, `fcf_yield`, `market_cap` (T/B/M), `beta`, `analyst.target_mean` |
| 10 | **SEC-отчётность** | чипы дат 10-K/10-Q + `filing_tone` + `filing_staleness_warning`; 8 плиток (revenue/NI/EPS Δ%, D/E→D/(D+E), долг Δ%, маржа, FCF Δ%, инсайдеры); **спарклайны** `quarterly_series` (SVG 80×24, тренд ±10%); суммы покупок/продаж инсайдеров; список 8-K событий с иконками; `mda_summary`, `top_risks[:3]`, `institutional_changes.notable_activity`, `risk_thesis.sec_filing_assessment` |
| 11 | Рыночный сентимент | плитки short %, short ratio, PCR, IV, дней до earnings / дата, средний EPS-сюрприз; футер `sentiment_interpretation`; при пустоте — «недоступно» |
| 12 | Self-critique | чип `assessment` (proceed/caution/strong_caution), `bear_case`, `missed_risks[]` |
| 13 | **Таблица пиров** | строка «сам» + `peers_comparison[]`: цена, cap, P/E trail/fwd, EV/EBITDA, рост выручки, ROE; треугольники ▲/▼ относительно себя (для P/E и EV — ниже лучше) |

Вкладка **Dividend** — та же структура с див. блоками (см. `04`, §4.9).

«Скопировать результат» — TSV-текст, зеркалящий все секции, в буфер обмена.

## 7.2. Страница «Сканер сектора» (`/market-scanner`)

1. **Карточки типа скана** (радио): 💎 Недооценённые (FV и MoS) / 📈 Дивидендные.
2. **Фильтры**: Stock List (Курируемый ~770 / Russell 2000); Sector (Все + список,
   см. `06`, §6.2); Market Cap (Все/Micro/Mid/Large); Volume (Все/Low/Medium/High);
   Top N (10/20/30/50). Кнопка «Запустить скан».
3. **Прогресс**: фазовый текст (`prescreening`: «Прескрининг… X/Y тикеров · прошло
   фильтр Z»; `deep_analysis`: «Глубокий анализ… X/Y компаний»; …), % считается
   на клиенте (`06`, §6.11 → формула в §7.5), ETA; счётчики: вселенная / прошло
   фильтр / проанализировано / ошибки. При `scanId = cache_*` — индикатор
   «Загрузка из кэша…».
4. **Результаты**: кэш-баннер (+«Обновить» = force), строка статистики, сортируемая
   таблица (колонки и пороги окраски — `06`, §6.11; у dividend — свой набор),
   «Копировать CSV», карточка **AI-советника** (текст LLM, санитизированный HTML).
5. Клик по тикеру → `/stock-analysis?ticker=…`.

## 7.3. Дизайн-интеграция (новый сайт)

Спека **не фиксирует** цвета оригинала. Фронтенд обязан использовать семантические
токены нового сайта; ниже — обязательный набор семантик и правила их применения:

| Токен (имя условное) | Где используется |
|---|---|
| `--color-card-bg / -border / -hover` | все карточки, таблицы, плитки |
| `--color-text-primary / -secondary / -muted` | значения / подписи / мета |
| `--color-positive / -negative / -neutral / -warning` | окраска метрик и вердиктов |
| `--color-verdict-{strong-buy, buy, hold, avoid, no-decision}` | баннер и бейджи вердикта (5 состояний) |
| `--font-display / -mono` | заголовки секций (каптализ, letter-spacing) / числа и тикеры |
| `--radius-{sm,md,lg}`, `--shadow-card` | карточки, чипы, плитки |

Правила окраски (пороги — часть поведения, не дизайна):

- вердикт: Strong Buy → positive, Buy → buy-акцент, Hold → warning, Avoid → negative,
  No Decision → нейтральный серый (и suppress MoS-подсветки);
- скор-плитки: ≥75 positive, ≥50 warning, <50 negative;
- MoS: ≥15% positive, <0 negative; любые проценты: знак определяет цвет;
- News badge: none=0 … severe=3 (сортировка и цвет по severity);
- подсветка строки сканера слева при UNDERVALUED-вердиктах.

## 7.4. SSE-клиент анализа

Транспорт — **`fetch()` с заголовками** (не `EventSource` — нужны Authorization и
Accept-Language): `GET /api/equity/analyze/{TICKER}/stream?lang=ru[&peers=…][&force=true]`,
`Accept: text/event-stream`. Ручной построчный парсинг: строки `data: …` → JSON.
Комментарии-хартбиты `: ka` игнорируются. Кадры: прогресс `{step, status, data}`,
терминальные `result` / `error` (+`_cache` в result от прокси).

- Повторный запуск: `AbortController.abort()` предыдущего запроса, сброс состояния.
- Обрыв стрима (не AbortError) → **recovery-поллинг** `GET …/result` каждые 3 c до
  10.5 мин: `204` = ещё считается, JSON = результат (бесплатно, списание уже было).
- `insufficient_credits` → дружелюбная ошибка с требуемым/доступным балансом.

## 7.5. Модель прогресса (анализ)

Гибрид «иллюзии движения + реальных якорей». Для каждой вкладки — таблица шагов
`{вес %, ожидаемая длительность ms}`:

```
equity:  init 0/0 · data_fetch 7/4000 · sec_filing 18/7000 · financial 28/2500 ·
         business 46/15000 · valuation 66/15000 · market_sentiment 76/4000 ·
         risk_analysis 92/14000 · decision 100/2500
dividend: init 0/0 · data_fetch 7/4000 · financial 17/2500 · cashflow 25/2000 ·
          quality 43/13000 · risk 60/13000 · valuation 77/13000 ·
          portfolio 92/13000 · decision 100/2500
```

`recomputeProgress` (каждые 100 мс + на каждый SSE-кадр):

1. Время с `startedAt` интерполируется между весами соседних шагов → `percent` (кап 95).
2. Перерасход бюджета времени: `95 + 4·(1 − e^{−overMs/30000})` → асимптота 99 (не «замирает»).
3. Реальный флор: вес последнего завершённого шага из SSE → `percent = min(99, max(время, флор))`.
4. Отображаемый шаг = самый продвинутый из {оценка по времени, running, done}.

Прогресс сканера: `total > 0 ? 50 + analyzed/total·50 : fetched/universeSize·50`;
ETA = `elapsed·(100−pct)/pct`.

## 7.6. Опционально: bias detector

Локальный лог запросов (localStorage, окно 48 ч). Паттерны: тот же тикер ≥ 3 раз
за 24 ч (loss aversion); прошлый вердикт содержал sell/avoid и снова ≥ 2 запросов
сегодня (confirmation bias); ≥ 5 разных тикеров за час (FOMO). Алерт с типом,
сообщением и советом, закрывается пользователем (запоминается на сессию).

## 7.7. i18n и глоссарий

- Локаль `ru` по умолчанию (в оригинале en+ru; в реплике ru-first, en — опция).
- Нарративы LLM приходят **уже на русском** (`05`, §5.2); фронтенд их не переводит.
- Словарь UI: ~250 ключей на страницу анализа (заголовки секций, метки метрик,
  лейблы enum'ов: moat/mispricing/tone/critique/divType/insider/epsQuality/dataQuality,
  подписи шагов `step_<id>`, предупреждения, дисклеймер) + ~100 на сканер.
- **Глоссарий финансовых терминов** (RU-only): ~50 записей
  `{term, tooltip, category}`; компонент-обёртка `FinancialTerm` добавляет
  tooltip к упомянутым метрикам. Категории: оценка, качество, маржи, риск,
  дивиденды, макро.

## 7.8. Форматтеры

`formatCurrency(v, 'USD')` (Intl, 2 зн., `—` для null); `formatPct` (значение уже
в процентах, `+5.0%`); `formatRatioPct` (доля 0.05 → `5.0%`); `formatSignedRatioPct`;
`formatNumber`; `formatLargeNumber` (T/B/M/K); `formatSmart` (группировка ≥1000,
3 зн. <1); `formatDate`. В view: локальные `mosPct` (`+12.3%`), `probPct`
(доля→%), D/E → D/(D+E) (отрицательное → «N/M»).
