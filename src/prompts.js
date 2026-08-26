// Единое хранилище промптов LLM-агентов лаборатории.
// Каждый промпт = { system, user(данные) }: тексты и инструкции живут здесь,
// данные (тикер, σ, новости, филлинги, контекст портфеля) подставляются
// вызывающими модулями. Изменение поведения агентов — правка этого файла.
//
// Общая конвенция всех промптов:
//   — system задаёт роль и требует ответ ТОЛЬКО в JSON (клиент src/llm.js
//     валидирует ответ схемой и переспрашивает при мусоре);
//   — user(...) собирает промпт из живых данных: что произошло + источники
//     (новости Yahoo RSS, филлинги SEC EDGAR) + строгая инструкция вывода;
//   — после каждого вызова пишется бюджет-лог data/llm-log.jsonl.

const fmtSigma = v => (v != null && Number.isFinite(+v) ? (+v).toFixed(1) : '?');

const PROMPTS = {

  // ── #2 ДЕТЕКТОР СЛОМА ТЕЗИСА ─────────────────────────────────────────────
  // Зачем: ответить на вопрос «упала цена или упал бизнес?». Когда бумага
  //   движется сильнее, чем объясняют её факторы (остаток > 2.5σ за день или
  //   5 дней), агент читает новости и филлинги и решает, цел ли тезис.
  // Когда: ежедневно (планировщик) после факторной модели; LLM вызывается
  //   ТОЛЬКО по флагу, cooldown 7 дней на тикер — бюджет не горит.
  // Вход: t/meta (позиция из META), thesis (состояние машины тезиса: state,
  //   опоры, задетые опоры, recovery_conditions), flag (аномалия в σ),
  //   news, filings.
  // Выход: verdict ∈ {beta_move — секторное движение, тезис цел;
  //   idiosyncratic_temporary — разовый шум без ущерба бизнесу;
  //   thesis_damage — задета опора тезиса} + reason + pillar + confidence
  //   + proposed_state (МНЕНИЕ агента о состоянии тезиса; решение принимают
  //   правила машины состояний по confidence — см. src/lab/theses.js).
  //   Вердикты thesis_damage автоматически попадают в data/recs.jsonl,
  //   двигают машину состояний и позже оцениваются «Точностью советов» (#6).
  // Модуль: src/lab/detector.js → attribute(); кэш data/cache/attribution/.
  detector: {
    system: 'Ты строгий аналитик фондового рынка. Отвечай только JSON.',
    user: ({ t, meta = {}, thesis = null, flag = {}, news = [], filings = [] }) => [
      `Тикер: ${t}. Позиция: тег ${meta.tag || '?'}, заметка: «${meta.note || '—'}».`,
      thesis ? `Состояние тезиса: ${thesis.state}. Опоры: ${thesis.pillars?.length ? thesis.pillars.join('; ') : 'не сформулированы'}.`
        + (thesis.damaged_pillars?.length ? ` Задетые опоры: ${thesis.damaged_pillars.join('; ')}.` : '')
        + (thesis.recovery_conditions?.length ? ` Условия восстановления: ${thesis.recovery_conditions.join('; ')}.` : '')
        : 'Записи тезиса нет — оценивай по заметке позиции.',
      `Факторная модель: аномалия дня ${fmtSigma(flag.lastSigma)}σ, за 5 дней ${fmtSigma(flag.cumSigma)}σ (остаток = движение бумаги минус движение, объяснённое факторами рынка/секторов).`,
      news.length ? 'Заголовки новостей (последние):' : 'Новостей нет.',
      ...news.slice(0, 10).map(n => `- ${n.title}${n.date ? ' (' + new Date(n.date).toISOString().slice(0, 10) + ')' : ''}`),
      filings.length ? 'Свежие филлинги SEC:' : 'Филлингов нет.',
      ...filings.slice(0, 5).map(f => `- ${f.form} от ${f.date}: ${f.url}`),
      '',
      'Классифицируй движение одной строкой verdict:',
      'beta_move — движение объяснимо факторами (сектор/рынок), тезис цел;',
      'idiosyncratic_temporary — бумажная/idio-аномалия без ущерба бизнесу (разовые продажи, шум, техфактор);',
      'thesis_damage — событие бьёт по опоре тезиса (гайденс, конкурент, регулятор, спрос).',
      'reason — одна фраза с конкретной причиной; pillar — какая опора тезиса задета (или «—»); confidence — 0..1.',
      'proposed_state — твоё мнение о состоянии тезиса: intact (цел) | watch (негативный сигнал, не подтверждён) | damaged (опора задета фактами) | dead (фальсификация).',
      'Верни ТОЛЬКО JSON: {"verdict":"beta_move|idiosyncratic_temporary|thesis_damage","reason":"…","pillar":"…","confidence":0.0,"proposed_state":"intact|watch|damaged|dead"}',
    ].join('\n'),
  },

  // ── #3 РЕЕСТР ФАЛЬСИФИКАЦИЙ · ГЕНЕРАЦИЯ УСЛОВИЙ ───────────────────────────
  // Зачем: «Поппер для портфеля». Пока тезис не сформулирован вместе с
  //   условиями собственной смерти, его нельзя опровергнуть — только
  //   рационализировать. Здесь агент формулирует тезис владельца и ровно
  //   ТРИ измеримых условия, при которых тезис мёртв (регистрируются ДО
  //   эмоциональной привязанности к позиции).
  // Когда: вручную кнопкой в /lab («Сгенерировать 3 условия»), по одному
  //   LLM-вызову на тикер; повторная генерация заменяет запись.
  // Вход: тикер, META (бакет, заметка, уровни докупа, ждущее событие),
  //   текущая цена, свежие новости и филлинги для контекста.
  // Выход: thesis (одно предложение) + pillars (опоры тезиса) + conditions[3]
  //   + recovery_conditions (что считать восстановлением) + пересмотр плана
  //   уровней (levels/until_*) — применяется к позиции через оверрайды
  //   и подпитывает машину состояний тезиса (#М1).
  // Модуль: src/lab/falsify.js → generate(); реестр data/falsifications.json.
  falsifyGenerate: {
    system: 'Ты аналитик, применяющий принцип фальсифицируемости Поппера к инвесттезисам. Отвечай только JSON.',
    user: ({ T, meta = {}, px = null, news = [], filings = [] }) => [
      `Тикер: ${T}. Бакет портфеля: ${meta.tag || '—'}. Заметка владельца: «${meta.note || '—'}».`,
      `Текущая цена: ${px != null ? (+px).toFixed(2) : 'недоступна'}. Действующие уровни докупа (T1/T2/T3): ${JSON.stringify(meta.lv ?? null)}.`,
      ...(meta.until ? [`Ждущее событие: «${meta.until.event}», проверка: ${meta.until.check || '—'}.`] : []),
      news.length ? 'Контекст новостей:' + news.slice(0, 6).map(n => '\n- ' + n.title).join('') : '',
      filings.length ? 'Филлинги: ' + filings.slice(0, 4).map(f => `${f.form} от ${f.date}`).join(', ') : '',
      '',
      'Сформулируй тезис владельца одним предложением и ровно ТРИ условия фальсификации:',
      'каждое — конкретное, измеримое по публичным данным (отчёты/новости), без оценочных слов;',
      'наступление любого условия означает, что тезис мёртв, и позицию надо закрывать или пересматривать.',
      'pillars — 2–4 опоры тезиса (короткие именованные предположения, на которых он стоит);',
      'recovery_conditions — 1–3 проверяемых условия восстановления, если тезис будет повреждён.',
      'Затем пересмотри план уровней относительно текущей цены:',
      'levels — ровно 3 элемента, числа или null (T1/T2/T3 — зоны докупа; null = не докупать на этом уровне);',
      'until_event — событие, до которого план у позиции ждать, или пустая строка; until_check — чем его проверить по публичным данным;',
      'note — одной фразой обновлённая суть позиции (можешь опустить).',
      'Верни ТОЛЬКО JSON: {"thesis":"…","pillars":["…"],"conditions":[{"text":"…"},{"text":"…"},{"text":"…"}],"recovery_conditions":["…"],"levels":[…],"until_event":"…","until_check":"…","note":"…"}',
    ].filter(Boolean).join('\n'),
  },

  // ── #3 РЕЕСТР ФАЛЬСИФИКАЦИЙ · ПРОВЕРКА УСЛОВИЙ ────────────────────────────
  // Зачем: регулярный аудит — сбылись ли зарегистрированные условия смерти
  //   тезиса. Ключевое ограничение: вердикт ONLY по предоставленным в промпте
  //   фактам (заголовки, филлинги) — прямой запрет выдумывать свидетельства.
  // Когда: ежеквартально (планировщик, cooldown 89 дней на запись) или
  //   кнопкой «Проверить» в /lab.
  // Вход: тезис, СОСТОЯНИЕ машины тезиса (intact/watch/…/dead), зарегистрированные
  //   условия (нумерованные), текущая цена, уровни, свежие новости и филлинги.
  // Выход: verdicts[{i, triggered, severity, evidence}] по каждому условию;
  //   severity: hard — условие смерти, позицию закрывать (→ dead);
  //   soft — условие выполнено частично/мягко, тезис повреждён (→ damaged).
  //   Любой triggered=true переводит запись в статус «ТРИГГЕР», а машина
  //   состояний получает событие falsify_hard/falsify_soft. Плюс
  //   proposed_state — мнение агента — и пересмотр плана уровней.
  // Модуль: src/lab/falsify.js → check()/checkAll().
  falsifyCheck: {
    system: 'Ты аудитор инвесттезисов. Работаешь строго по предоставленным данным, не галлюцинируешь факты. Отвечай только JSON.',
    user: ({ T, thesis = '', state = null, meta = {}, px = null, conditions = [], news = [], filings = [] }) => [
      `Тикер: ${T}. Тезис: «${thesis}».`,
      state ? `Текущее состояние тезиса: ${state}.` : '',
      `Текущая цена: ${px != null ? (+px).toFixed(2) : 'недоступна'}. Действующие уровни докупа (T1/T2/T3): ${JSON.stringify(meta.lv ?? null)}.`,
      'Условия фальсификации:',
      ...conditions.map((c, i) => `${i}. ${c.text}`),
      news.length ? 'Заголовки (последние):' + news.slice(0, 10).map(n => '\n- ' + n.title).join('') : 'Новостей нет.',
      filings.length ? 'Филлинги: ' + filings.slice(0, 5).map(f => `${f.form} от ${f.date}: ${f.url}`).join('\n') : 'Филлингов нет.',
      '',
      'По каждому условию вынеси вердикт на основе ПРИВЕДЁННЫХ данных (не выдумывай факты):',
      'triggered=true только если есть прямое свидетельство; иначе false с кратким evidence (что известно);',
      'severity=hard — условие смерти тезиса в полной мере; soft — выполнено частично или формулировка мягкая (повреждение, не смерть).',
      'proposed_state — твоё мнение о состоянии тезиса после проверки: intact|watch|damaged|dead.',
      'Дополнительно пересмотри план уровней относительно текущей цены: levels — ровно 3 элемента, числа или null;',
      'until_event — событие, до которого ждать, или пустая строка; until_check — чем его проверить.',
      'Верни ТОЛЬКО JSON: {"verdicts":[{"i":0,"triggered":false,"severity":"hard|soft","evidence":"…"},…],"proposed_state":"…","levels":[…],"until_event":"…","until_check":"…"}',
    ].filter(Boolean).join('\n'),
  },

  // ── #10 КОМИТЕТ АГЕНТОВ · ПРОГНОЗЫ С КАЛИБРОВКОЙ ──────────────────────────
  // Зачем: четыре конкурирующих взгляда на один и тот же портфель. Каждое
  //   утверждение фиксируется как вероятностный прогноз в машинной грамматике,
  //   чтобы потом свериться с фактом и посчитать Brier — кто из агентов
  //   врёт, а кто калиброван. Веса консенсуса = softmax(−Brier): точная роль
  //   со временем получает больший вес.
  // Когда: еженедельно (планировщик) или кнопкой «Созвать комитет»; между
  //   ролями пауза 3 с — бережём rate-limit. Роли:
  //   bull        — ищет аргументы за рост;
  //   bear        — за падение;
  //   devil       — адвокат дьявола, атакует консенсус;
  //   baserates   — только историческая частота, без нарративов.
  // Вход: контекст портфеля (стоимость, вердикт системы, топ-факторные
  //   экспозиции, флаги детектора, отчёты ≤30 дн, S&P/VIX, тикеры).
  // Выход: РОВНО 5 прогнозов на 7–365 дней: тикер/S&P выше-ниже на X%,
  //   VIX выше-ниже уровня, каждый с prob 0.05..0.95 и rationale.
  //   Созревшие прогнозы разрешаются ценами Yahoo → Brier по ролям.
  // Модуль: src/lab/committee.js → runCommittee(); лог data/predictions.jsonl.
  committee: {
    system: 'Ты участник инвестиционного комитета. Отвечай только JSON.',
    personas: {
      bull: 'Ты убеждённый бык: ищи аргументы за рост, но давай честные вероятности.',
      bear: 'Ты убеждённый медведь: ищи аргументы за падение, но давай честные вероятности.',
      devil: 'Ты адвокат дьявола: атакуй консенсус, ищи то, что все упускают.',
      baserates: 'Ты опираешься только на базовые ставки и историческую частоту событий, без нарративов.',
    },
    user: ({ role, ctx = {} }) => {
      const persona = PROMPTS.committee.personas[role];
      if (!persona) throw new Error(`неизвестная роль комитета: ${role}`);
      return [
        persona,
        '',
        'Портфель: $' + (ctx.total || '?') + ', вердикт системы: ' + (ctx.verdict || '?') + '.',
        'Факторные экспозиции: ' + (ctx.topFactors?.join(', ') || 'нет') + '.',
        'Флаги детектора: ' + (ctx.detectorFlags?.join(', ') || 'нет') + '.',
        'Состояния тезисов: ' + (ctx.thesisStates?.join(', ') || 'все целы') + '.',
        'Отчёты близко: ' + (ctx.earnings?.join(', ') || 'нет') + '.',
        'S&P ' + (ctx.spx || '?') + ', VIX ' + (ctx.vix || '?') + '.',
        'Тикеры портфеля: ' + (ctx.tickers?.join(', ') || '') + '.',
        '',
        'Дай РОВНО ПЯТЬ прогнозов на 7–365 дней вперёд в строгой грамматике:',
        '{"kind":"price_above"|"price_below","t":"ТИКЕР","ref":<цена сейчас>,"x":<доля, напр. 0.08>,"horizon_days":N}',
        '{"kind":"index_above"|"index_below","ref":<уровень S&P сейчас>,"x":<доля>,"horizon_days":N}',
        '{"kind":"vix_above"|"vix_below","level":N,"horizon_days":N}',
        'Обязательно: МИНИМУМ ОДИН прогноз с горизонтом ≤ 30 дней — иначе набор отклоняется целиком.',
        'prob — твоя вероятность 0.05..0.95; НЕ дави к 0.5: прогноз с prob ≈ baseline случайного блуждания бесполезен и будет отброшен.',
        'Верни ТОЛЬКО JSON: {"predictions":[{…5 шт…}]}',
      ].join('\n');
    },
  },

  // ── #7 БАЗОВЫЕ СТАВКИ · КЛАССИФИКАЦИЯ СОБЫТИЯ ─────────────────────────────
  // Зачем: «а что ОБЫЧНО бывает после такого?» — взгляд снаружи вместо
  //   уникального кейса. Инвестор описывает ситуацию, агент относит её к
  //   эмпирическому классу (если подходит) и даёт свой приор. Эмпирика и
  //   мнение модели показываются в UI раздельно и с метками — приор
  //   сознательно помечается как «МНЕНИЕ МОДЕЛИ, не данные».
  // Когда: по запросу — поле «что обычно происходит после…» в /lab.
  // Вход: текст события инвестора + список доступных эмпирических классов
  //   с числом событий (из базы S&P 500 за 10 лет).
  // Выход: class ∈ {drawdown40, shock15, guidance_cut, ceo_exit, dilution,
  //   insider_cluster, none}; далее модуль прикрепляет эмпирическое
  //   распределение форвардных доходностей (если класс эмпирический)
  //   и llmPrior {note, median12m} рядом, с пометкой источника каждого.
  // Модуль: src/lab/baserates.js → query().
  baserates: {
    system: 'Ты аналитик базовых ставок. Отвечай только JSON.',
    user: ({ text, classes }) => [
      'Событие инвестора: «' + text + '».',
      'Классифицируй его. Эмпирические классы: ' + classes + '.',
      'Если не подходит ничего — class=none.',
      'prior_note — как обычно складывается исход таких событий по экономической логике (1 фраза);',
      'prior_median_12m — твоя оценка медианной 12-мес доходности после события, % (это МНЕНИЕ МОДЕЛИ, будет помечено).',
      'Верни ТОЛЬКО JSON: {"class":"…","prior_note":"…","prior_median_12m":0.0}',
    ].join('\n'),
  },

  // ── #М2 ПЕРЕВЫВОД УРОВНЕЙ ОТ СОСТОЯНИЯ ТЕЗИСА ─────────────────────────────
  // Зачем: старые уровни выводились из старых фундаменталей и после смены
  //   состояния НЕДЕЙСТВИТЕЛЬНЫ. Агент даёт якоря (база EPS, диапазон
  //   мультипликатора, условие подтверждения), математика в
  //   src/lab/derivation.js собирает из них сетку: fair range → MoS по числу
  //   задетых опор → привлекательная зона → разнос 0.75σ.
  // Когда: ТОЛЬКО по триггеру — смена состояния, отчёт (T+1 цепочка),
  //   фальсификация, уход цены >25% от derived_at, кнопка «Перевывести».
  // Вход: запись тезиса (state, опоры, задетые опоры, условия восстановления),
  //   цена, σ годовая в долларах, новости, филлинги.
  // Выход: якоря для математики. Для damaged ОБЯЗАТЕЛЬНЫ eps + диапазон
  //   мультипликатора + confirm_event/check (уровень активируется парой
  //   «цена + факт», не одной ценой). Для dead — план выхода. Для
  //   intact/recovering — прямая сетка levels[3].
  // Модуль: src/lab/derivation.js → runDerive()/deriveExit().
  levelsDerive: {
    system: 'Ты оценщик, выводящий план докупа из фундаменталий. Числа — только из приведённых данных; чего нет — пиши 0 и объясни в basis. Отвечай только JSON.',
    user: ({ rec = {}, px = null, sigmaUsd = null, news = [], filings = [] }) => [
      `Тикер: ${rec.t}. Состояние тезиса: ${rec.state}.`,
      `Тезис: «${rec.thesis || '—'}». Опоры: ${(rec.pillars || []).join('; ') || 'не сформулированы'}.`,
      (rec.damaged_pillars || []).length ? `Задетые опоры: ${rec.damaged_pillars.join('; ')}.` : '',
      (rec.recovery_conditions || []).length ? `Условия восстановления: ${rec.recovery_conditions.join('; ')}.` : '',
      `Текущая цена: ${px != null ? (+px).toFixed(2) : 'недоступна'}; годовая σ ≈ ${sigmaUsd != null ? '$' + (+sigmaUsd).toFixed(0) : 'недоступна'}.`,
      news.length ? 'Новости:' + news.slice(0, 8).map(n => '\n- ' + n.title).join('') : 'Новостей нет.',
      filings.length ? 'Филлинги: ' + filings.slice(0, 5).map(f => `${f.form} от ${f.date}`).join(', ') : 'Филлингов нет.',
      '',
      rec.state === 'damaged' ? [
        'Выведи якоря для новой сетки (старые уровни аннулированы):',
        'eps — нормализованная база прибыли на акцию: min(текущий гайденс, консенсус forward EPS); если гайденс срезан — срезанный; если срезан дважды — eps с учётом haircut_pct 5–10;',
        'eps_basis — откуда число (гайденс/консенсус, источник);',
        'multiple_low/multiple_high — сжатый мультипликатор для повреждённого бизнеса: нижняя часть диапазона из медианы отрасли, собственной истории и сопоставимых компаний; multiple_basis — обоснование;',
        'confirm_event/confirm_check — ОБЯЗАТЕЛЬНОЕ условие подтверждения для активации любого уровня (например «стабилизация US-сегмента в следующем отчёте»);',
        'exit_* — заполни нулями.',
      ].join('\n') : rec.state === 'dead' ? [
        'Уровней нет — выведи план выхода:',
        'exit_target — целевая цена продажи на отскоке (технически достижимая, иначе 0);',
        'exit_deadline_days — окно выхода в днях (по умолчанию 90);',
        'exit_note — правило выхода одной фразой, включая «продать в любом случае к дате».',
        'Остальные числа — нули, levels — пустой массив.',
      ].join('\n') : [
        'Уровни для текущего состояния (intact/recovering/watch):',
        'levels — ровно 3 элемента, числа или null (T1/T2/T3, зоны докупа от текущей цены);',
        rec.state === 'recovering'
          ? 'recovering: уровни УСЛОВНЫЕ — каждый требует подтверждения; заполни confirm_event/confirm_check конкретным проверяемым фактом.'
          : 'confirm_event/check — заполни, только если уровню нужно ждать событие.',
        'eps/multiple_* — нули, exit_* — нули.',
      ].join('\n'),
      'Верни ТОЛЬКО JSON: {"eps":0.0,"eps_basis":"…","multiple_low":0.0,"multiple_high":0.0,"multiple_basis":"…","haircut_pct":0,"confirm_event":"…","confirm_check":"…","levels":[…],"exit_target":0,"exit_deadline_days":0,"exit_note":"…"}',
    ].filter(Boolean).join('\n'),
  },

  // ── #М3 ПЕРЕОЦЕНКА ТЕЗИСА ПОСЛЕ ОТЧЁТА (T+1) ──────────────────────────────
  // Зачем: отчёт — главный принудительный пересмотр состояния. Наутро
  //   после отчёта агент читает результат против опор и условий
  //   восстановления и предлагает: состояние, ухудшение (да/нет), число
  //   подтверждённых условий — дальше решают ПРАВИЛА машины состояний
  //   (damaged + два чистых отчёта → recovering и т.д.).
  // Когда: T+1 день после отчёта (планировщик, каждый отчёт один раз) или
  //   кнопка «Переоценить по отчёту».
  // Вход: запись тезиса, ожидание рынка (earnings + EPS surprise, если есть),
  //   свежие новости и филлинги, цена и реакция цены за день.
  // Выход: proposed_state, deterioration, recovery_confirmed (индексы
  //   подтверждённых условий), damaged_pillars, evidence + якоря уровней
  //   (те же поля, что в levelsDerive — перевывод следует сразу).
  // Модуль: src/lab/calendar.js → runEarningsChain().
  thesisReview: {
    system: 'Ты аналитик, сверяющий отчёт компании с зарегистрированным тезисом. Работаешь строго по предоставленным данным. Отвечай только JSON.',
    user: ({ rec = {}, earnings = {}, px = null, dayMove = null, news = [], filings = [] }) => [
      `Тикер: ${rec.t}. Состояние тезиса: ${rec.state}.`,
      `Тезис: «${rec.thesis || '—'}». Опоры: ${(rec.pillars || []).join('; ') || 'не сформулированы'}.`,
      (rec.damaged_pillars || []).length ? `Задетые опоры: ${rec.damaged_pillars.join('; ')}.` : '',
      (rec.recovery_conditions || []).length
        ? 'Условия восстановления (нумерованные):\n' + rec.recovery_conditions.map((c, i) => `${i}. ${c}`).join('\n')
        : 'Условия восстановления не зарегистрированы.',
      earnings.date ? `Отчёт вышел: ${earnings.date}${earnings.surprisePct != null ? ', EPS-сюрприз ' + earnings.surprisePct.toFixed(1) + '%' : ''}.` : 'Отчёт: дата неизвестна.',
      `Цена сейчас: ${px != null ? (+px).toFixed(2) : 'недоступна'}${dayMove != null ? ', реакция за день ' + (dayMove >= 0 ? '+' : '') + (dayMove * 100).toFixed(1) + '%' : ''}.`,
      news.length ? 'Заголовки про отчёт:' + news.slice(0, 10).map(n => '\n- ' + n.title).join('') : 'Новостей нет.',
      filings.length ? 'Филлинги: ' + filings.slice(0, 5).map(f => `${f.form} от ${f.date}`).join(', ') : 'Филлингов нет.',
      '',
      'Сверь отчёт с тезисом:',
      'deterioration=true — стало ХУЖЕ (опоры просели дальше), false — ухудшения нет;',
      'recovery_confirmed — массив индексов подтверждённых условий восстановления (только прямые свидетельства);',
      'damaged_pillars — актуальный список задетых опор после этого отчёта;',
      'proposed_state — твоё мнение: intact|watch|damaged|recovering|dead (решение примут правила по deterioration/подтверждениям);',
      'evidence — одна фраза с ключевым фактом отчёта.',
      'Если состояние после этого отчёта — damaged, дай якоря уровней: eps (база min(гайденс, консенсус)), multiple_low/high (сжатый диапазон), haircut_pct, confirm_event/check. Иначе нули.',
      'Верни ТОЛЬКО JSON: {"deterioration":false,"recovery_confirmed":[…],"damaged_pillars":[…],"proposed_state":"…","evidence":"…","eps":0.0,"eps_basis":"…","multiple_low":0.0,"multiple_high":0.0,"multiple_basis":"…","haircut_pct":0,"confirm_event":"…","confirm_check":"…"}',
    ].filter(Boolean).join('\n'),
  },

  // ── #М5 ЗАПРОС «СТОИТ ЛИ ПОКУПАТЬ X» ──────────────────────────────────────
  // Зачем: единая точка входа вместо внешнего аналитика. Система собирает
  //   чек-лист (состояние тезиса, события, классификация движения, уровни,
  //   ограничения мандата, проксимити отчёта, базовые ставки), агент
  //   выносит решение по фиксированному протоколу.
  // Когда: вручную — форма «стоит ли покупать» в /lab (владелец).
  // Вход: тикер + сумма; собранный машиной контекст (снапшот тезиса,
  //   календарь, детектор, уровни, мандат, эмпирика базовых ставок).
  // Выход: decision ∈ buy_full|buy_half|wait|no|no_decision — однозначно;
  //   при no_decision — список missing (чего не хватает). Размер считает
  //   машина (акции, доли после покупки) — агент его НЕ придумывает.
  // Модуль: src/lab/buycheck.js → runBuyCheck().
  buyCheck: {
    system: 'Ты дисциплинированный портфельный менеджер, работающий по мандату владельца: горизонт 5–10 лет, потолок имени 8,4%, AI-бета ≤35%, дивиденды токсичны, качество покупается по справедливой цене через DCA, дорогое/параболическое — только лестницей на просадках. Отвечай только JSON.',
    user: ({ t, usd, px, thesis = {}, calendar = {}, movement = {}, levels = {}, mandate = {}, baserates = null, detector = null, news = [], filings = [] }) => [
      `Запрос: докупить ${t} на $${Math.round(usd)} (цена ${px != null ? (+px).toFixed(2) : '?'}, ~${px > 0 ? Math.floor(usd / px) : '?'} акций).`,
      `Состояние тезиса: ${thesis.state || 'нет записи'}${thesis.history?.length ? ', переходов: ' + thesis.history.length : ''}${thesis.state === 'damaged' || thesis.state === 'dead' ? ' — покупка по умолчанию запрещена, нужно исключительное обоснование' : ''}.`,
      `Отчёт: ${calendar.days != null ? (calendar.days === 0 ? 'сегодня!' : 'через ' + calendar.days + ' дн') + (calendar.days <= 7 ? ' — БИНАРНЫЙ РИСК, правило владельца: полный транш перед отчётом запрещён' : '') : 'дата неизвестна'}.`,
      `Классификация движения: ${movement.class || 'нет данных'}${movement.reason ? ' — ' + movement.reason : ''}.`,
      levels.active ? `Уровни: T1 ${levels.t1} / T2 ${levels.t2} / T3 ${levels.t3}${levels.inZone ? ' — цена В зоне' : ''}${levels.until ? ' — ждёт подтверждения: ' + levels.until : ''}.` : 'Действующих уровней нет.',
      `Мандат: AI-доля ${mandate.aiPct != null ? (mandate.aiPct * 100).toFixed(1) + '% / потолок 35%' : '?'}; доля имени после покупки ${(mandate.namePctAfter != null ? (mandate.namePctAfter * 100).toFixed(1) : '?')}% / потолок 8,4%; кэш после ${(mandate.cashPctAfter != null ? (mandate.cashPctAfter * 100).toFixed(1) : '?')}% / цель 10%.`,
      detector ? `Детектор по тикеру: ${detector.verdict} (${detector.reason || '—'}).` : 'Детектор: аномалий не зафиксировано.',
      baserates ? `Базовые ставки класса «${baserates.class}»: медиана 12м ${baserates.median12m != null ? baserates.median12m + '%' : '?'}.` : 'Базовые ставки: класс не определён.',
      news.length ? 'Новости (30 дн):' + news.slice(0, 8).map(n => '\n- ' + n.title).join('') : 'Новостей нет.',
      filings.length ? 'Филлинги (30 дн): ' + filings.slice(0, 5).map(f => `${f.form} от ${f.date}`).join(', ') : 'Филлингов нет.',
      '',
      'Вынеси решение по протоколу:',
      'decision: buy_full — все пункты за (тезис цел, цена в зоне/справедлива, мандат не пробивается, отчёт не рядом);',
      'buy_half — частично за (один пункт спорный: сигнал не подтверждён, пол-зоны, потолок близко);',
      'wait — ждать конкретного события (wait_what — ЧТО именно ждать);',
      'no — против (тезис повреждён/мёртв, мандат пробит, параболика без просадки);',
      'no_decision — данных не хватает; missing — список того, чего не хватает. НИКОГДА не выдумывай решение без данных.',
      'reason — одна фраза с главной причиной.',
      'Верни ТОЛЬКО JSON: {"decision":"buy_full|buy_half|wait|no|no_decision","wait_what":"…","missing":["…"],"reason":"…"}',
    ].filter(Boolean).join('\n'),
  },

  // ── ФУНДАМЕНТАЛЬНАЯ ОЦЕНКА (docs/spec-replica) ───────────────────────────
  // Общая конвенция блока equity*/div*: система даёт роль + «Текущий год —
  // YYYY. Используй только данные YYYY-1–YYYY» + ОБЯЗАТЕЛЬНЫЙ русский всех
  // текстовых полей (спека 05 §5.2); user(...) подставляет живые числа.
  // Математика (FV/MoS/скор/вердикт) считается кодом — LLM только
  // интерпретирует, и его арифметика канонически пересчитывается оркестратором.

  // Бизнес-агент (05 §5.3): качество бизнеса, ров, траектория отрасли.
  equityBusiness: {
    system: 'Ты аналитик long/short хедж-фонда, специализирующийся на качестве бизнеса и конкурентных преимуществах. Оцени бизнес-модель, источник устойчивости прибыли (moat) и траекторию отрасли. Будь конкретен и скептичен, не пересказывай описание компании. Текущий год — {YEAR}. Используй только данные {YEAR_M1}–{YEAR}. ОБЯЗАТЕЛЬНОЕ ТРЕБОВАНИЕ К ЯЗЫКУ ОТВЕТА: весь текстовый контент (описания, пояснения, инсайты, опасения) — ТОЛЬКО на русском. Ключи JSON и числа оставляй как есть. Отвечай только JSON.',
    user: ({ ds, fm }) => [
      `Компания: ${ds.meta?.name} (${ds.meta?.ticker}), сектор ${ds.meta?.sector || '?'}, индустрия ${ds.meta?.industry || '?'}.`,
      `Описание: ${(ds.meta?.description || 'нет').slice(0, 400)}.`,
      `Выручка (5 лет, свежая первой): ${JSON.stringify((ds.derived?.revenue || []).slice(0, 5))}.`,
      `CAGR выручки 3 г: ${fm.revenue_cagr_3y != null ? (fm.revenue_cagr_3y * 100).toFixed(1) + '%' : '?'}; тренд: ${fm.revenue_trend}.`,
      `Средние за 5 лет: опер. маржа ${((fm.avg_operating_margin || 0) * 100).toFixed(1)}%, ROIC ${((fm.avg_roic || 0) * 100).toFixed(1)}%.`,
      `Доля FCF-положительных лет: ${fm.fcf_available_years ? Math.round(100 * fm.fcf_positive_years / fm.fcf_available_years) : '?'}%.`,
      `P/E trail ${ds.multiples?.pe_trailing ?? '?'} / fwd ${ds.multiples?.pe_forward ?? '?'}, EV/EBITDA ${ds.multiples?.ev_ebitda ?? '?'}.`,
      `Цикличность: ${fm.cyclicality_tag || 'нецикличная'}.`,
      ds.news_context?.length ? 'Контекст новостей (6 мес):' + ds.news_context.slice(0, 10).map(n => '\n- ' + n.title).join('') : 'Новостей нет.',
      '',
      'Оцени: business_model (2–4 предложения), revenue_type, moat_type, moat_description,',
      'moat_score/industry_score/business_score 0–10 (целые), industry_trend, industry_cyclicality, key_insights[2–4], concerns[1–3].',
      'Верни ТОЛЬКО JSON: {"business_model":"…","revenue_type":"recurring|transactional|project-based|cyclical|mixed","moat_type":"switching_cost|network_effect|brand|cost_advantage|intangible_assets|efficient_scale|none","moat_description":"…","moat_score":0,"industry_trend":"growing|stable|declining|disrupted","industry_cyclicality":"secular|mild_cyclical|highly_cyclical","industry_score":0,"business_score":0,"key_insights":["…"],"concerns":["…"]}',
    ].join('\n'),
  },

  // Валюационный нарратив (05 §5.4): поверх УЖЕ посчитанных чисел.
  equityValuation: {
    system: 'Ты специалист по оценке в long/short хедж-фонде. Справедливая стоимость УЖЕ посчитана детерминированной мульти-методной моделью (двухстадийный DCF, EPV, обоснованные P/E и EV/EBITDA, число Грэма, дисконтированная цель аналитиков). НЕ пересчитывай и не оспаривай предоставленные числа — интерпретируй их. Реалистично относись к циклическим пикам против нормализованной прибыли. Текущий год — {YEAR}. Используй только данные {YEAR_M1}–{YEAR}. Весь текст — на русском. Отвечай только JSON.',
    user: ({ ds, val, business, fm }) => [
      `Компания: ${ds.meta?.name} (${ds.meta?.ticker}), цена $${ds.meta?.current_price}, капитализация $${ds.meta?.market_cap}.`,
      `Ров: ${business?.moat_type || '?'} (score ${business?.moat_score ?? '?'}/10).`,
      `Справедливая стоимость: base $${val.base}, bear $${val.bear} (25%), base 50%, bull $${val.bull} (25%); ожидаемая $${val.expected_value}.`,
      `MoS: ${val.margin_of_safety_pct}%. Методы (значение/вес): ${val.methods.map(m => `${m.name}=$${m.value}/${m.weight}`).join(', ')}.`,
      `Допущения: ${val.assumptions}.`,
      `Цель аналитиков: $${val.analyst_target ?? '?'} (PV $${val.analyst_target_pv ?? '?'}).`,
      `Мультипликаторы: ${JSON.stringify(ds.multiples)}.`,
      `ROIC ср. ${((fm.avg_roic || 0) * 100).toFixed(1)}%; выручка CAGR3 ${((fm.revenue_cagr_3y || 0) * 100).toFixed(1)}%.`,
      val.no_estimate ? 'ВНИМАНИЕ: оценка помечена no_estimate — в тексте подчеркни, что точечной оценке доверять нельзя, работает только диапазон.' : '',
      '',
      'Напиши: relative_assessment (относительно сектора и собственной истории мультипликаторов),',
      'valuation_narrative (2–4 абзаца интерпретации на русском), dcf_assumptions (перечисление ключевых допущений), is_cyclically_adjusted (bool).',
      'Верни ТОЛЬКО JSON: {"relative_assessment":"…","valuation_narrative":"…","dcf_assumptions":"…","is_cyclically_adjusted":false}',
    ].filter(Boolean).join('\n'),
  },

  // Риск-агент (05 §5.5): инвестиционный тезис и mispricing.
  equityRisk: {
    system: 'Ты портфельный менеджер, пишущий внутренний меморандум. Объясни, почему акция дешёва или дорога, что рынок упускает, структура это или временное явление. Одноразовые прибыли искажают trailing P/E — сравнивай forward и trailing осмотрительно. Текущий год — {YEAR}. Весь текст — на русском. Отвечай только JSON.',
    user: ({ ds, fm, business, val, sec, sentiment }) => [
      `Компания: ${ds.meta?.name} (${ds.meta?.ticker}), сектор ${ds.meta?.sector || '?'}, цена $${ds.meta?.current_price}.`,
      `Бизнес: score ${business?.business_score ?? '?'}/10, ров ${business?.moat_type || '?'} ${business?.moat_score ?? '?'}/10, тренд отрасли ${business?.industry_trend || '?'}.`,
      `Финансовое качество: CAGR3 ${((fm.revenue_cagr_3y || 0) * 100).toFixed(1)}% (${fm.revenue_trend}), маржа ср. ${((fm.avg_operating_margin || 0) * 100).toFixed(1)}% (${fm.margin_trend}), ROIC ${((fm.avg_roic || 0) * 100).toFixed(1)}%, FCF-лет ${fm.fcf_positive_years}/${fm.fcf_available_years}, долг/EBITDA ${fm.avg_debt_ebitda != null ? fm.avg_debt_ebitda.toFixed(1) : '?'}, Piotroski ${fm.piotroski_f}/7.`,
      `EPS: trailing ${fm.trailing_eps ?? '?'} / forward ${fm.forward_eps ?? '?'} (${fm.eps_quality_flag}).`,
      `Оценка: base $${val.base} (bear $${val.bear} / bull $${val.bull}), MoS ${val.margin_of_safety_pct}%, «поддержано» $${val.supported_value}, в цене заложено $${val.priced_in}.`,
      `Мультипликаторы: ${JSON.stringify(ds.multiples)}.`,
      `SEC: ${JSON.stringify({ data_available: sec?.data_available, revenue_change_pct: sec?.revenue_change_pct, margin_change: sec?.margin_change, insider: sec?.recent_form4?.activity_signal, tone: sec?.filing_tone, events8k: (sec?.recent_8k_events || []).length })}.`,
      `Сентимент: ${JSON.stringify(sentiment)}.`,
      '',
      'Выход: why_cheap_or_expensive, is_temporary_or_structural, what_market_misses, mispricing_type,',
      'catalysts[2–4], key_risks[2–4], time_horizon, thesis_summary, risk_score 0–10 (10 — макс. риск),',
      'sec_filing_assessment, sentiment_interpretation.',
      'Верни ТОЛЬКО JSON: {"why_cheap_or_expensive":"…","is_temporary_or_structural":"temporary|structural|fairly_valued","what_market_misses":"…","mispricing_type":"opportunity|value_trap|fairly_valued|overvalued_justified|overvalued_bubble","catalysts":["…"],"key_risks":["…"],"time_horizon":"6-12 months|1-2 years|3-5 years|>5 years","thesis_summary":"…","risk_score":5,"sec_filing_assessment":"…","sentiment_interpretation":"…"}',
    ].join('\n'),
  },

  // News radar (05 §5.6): классификация негативных заголовков.
  equityNews: {
    system: 'Ты риск-аналитик новостей. Текущий год — {YEAR}. Отвечай только JSON.',
    user: ({ t, name, hits }) => [
      `Компания: ${name} (${t}). Ниже — негативно-окрашенные заголовки за 90 дней:`,
      ...hits.slice(0, 12).map(h => `- ${h.date || '?'}: ${h.title}`),
      '',
      'Классифицируй совокупный риск: risk_level ∈ none|watch|elevated|severe|unknown.',
      'events — до 5 самых значимых: type ∈ fraud|litigation|regulatory|short_seller|guidance|accounting|management|other, headline (сжатая формулировка на русском), date, summary (1 предложение на русском).',
      'elevated/severe без событий запрещены. summary — общий вывод на русском (1–2 предложения).',
      'Верни ТОЛЬКО JSON: {"risk_level":"none","events":[{"type":"other","headline":"…","date":"YYYY-MM-DD","summary":"…"}],"summary":"…"}',
    ].join('\n'),
  },

  // 10-K MD&A-саммари (05 §5.6).
  equityMda: {
    system: 'Ты аналитик, читающий 10-K. Извлеки суть без пересказа. Текущий год — {YEAR}. Весь текст — на русском. Отвечай только JSON.',
    user: ({ mda, risks }) => [
      'Фрагмент MD&A (Item 7) последнего 10-K:',
      mda.slice(0, 6000),
      '',
      'Фрагмент рисков (Item 1A):',
      risks.slice(0, 3000),
      '',
      'Верни: mda_summary (3–5 предложений на русском о состоянии бизнеса по MD&A),',
      'top_risks — 3–5 главных рисков компании (на русском, кратко),',
      'filing_tone ∈ positive|cautiously_optimistic|neutral|cautious|negative.',
      'Верни ТОЛЬКО JSON: {"mda_summary":"…","top_risks":["…"],"filing_tone":"neutral"}',
    ].join('\n'),
  },

  // Self-critique (04 §4.5): скептик-риск-менеджер, только при confidence ≥ 80.
  equityCritique: {
    system: 'Ты скептичный риск-менеджер хедж-фонда. Твоя работа — атаковать решение аналитика. Текущий год — {YEAR}. Весь текст — на русском. Отвечай только JSON.',
    user: ({ t, verdict, conf, mos, risk, business, sec }) => [
      `Тикер: ${t}. Предлагаемый вердикт: ${verdict} (уверенность ${conf}%, MoS ${mos}%).`,
      `Risk score ${risk?.risk_score ?? '?'}/10, mispricing ${risk?.mispricing_type || '?'}.`,
      `Ров: ${business?.moat_type || '?'} ${business?.moat_score ?? '?'}/10.`,
      `Инсайдеры: ${sec?.recent_form4?.activity_signal || '?'}; тон отчёта ${sec?.filing_tone || '?'}; институционалы: ${sec?.institutional_changes?.notable_activity || 'нет данных'}.`,
      '',
      'Дай медвежий кейс (bear_case, 2–3 предложения), confidence_adjustment (int −20..+5),',
      'missed_risks (1–3), final_assessment ∈ proceed|caution|strong_caution.',
      'Верни ТОЛЬКО JSON: {"bear_case":"…","confidence_adjustment":0,"missed_risks":["…"],"final_assessment":"proceed"}',
    ].join('\n'),
  },

  // Сканер-советник (06 §6.9): саммари по top-5 строкам скана.
  equityAdvisor: {
    system: 'Ты портфельный стратег. Пиши по-русски, сжато и по делу, без маркетинговых оборотов. Отвечай только JSON.',
    user: ({ rows, scanType, cluster }) => [
      `Тип скана: ${scanType === 'dividend' ? 'дивидендные кандидаты' : 'недооценённые качественные компании'}.`,
      'Топ-строки результатов (тикер · компания · сектор · цена · MoS% · скор · ROIC · P/E · red flags):',
      ...rows.slice(0, 5).map(r => `- ${r.ticker} · ${r.name || '?'} · ${r.sector || '?'} · $${r.currentPrice ?? r.current_price ?? '?'} · ${r.valuation?.marginOfSafety ?? r.margin_of_safety_pct ?? '?'}% · ${r.scores?.scanScore ?? '?'} · ${r.keyMetrics?.roic ?? '?'} · ${r.keyMetrics?.peTrailing ?? '?'} · crit ${r.redFlags?.critical ?? 0}/warn ${r.redFlags?.warnings ?? 0}`),
      cluster ? 'ПРЕДУПРЕЖДЕНИЕ О КЛАСТЕРИЗАЦИИ: ' + cluster : '',
      '',
      'Напиши 3–4 абзаца на русском: что общего у найденных компаний, на что смотреть',
      'в первую очередь, ключевые оговорки. Не повторяй таблицу, интерпретируй.',
      'Верни ТОЛЬКО JSON: {"summary":"…"}',
    ].filter(Boolean).join('\n'),
  },

  // ── Дивидендный пайплайн (04 §4.9) ──
  divQuality: {
    system: 'Ты аналитик дивидендных стратегий. Текущий год — {YEAR}. Весь текст — на русском. Отвечай только JSON.',
    user: ({ ds, fm }) => [
      `Компания: ${ds.meta?.name} (${ds.meta?.ticker}), сектор ${ds.meta?.sector || '?'}.`,
      `Дивиденды: yield ${((ds.dividend_data?.yield || 0) * 100).toFixed(2)}%, годовой DPS $${ds.dividend_data?.annual_dps ?? '?'}, payout ${((ds.dividend_data?.payout_ratio || 0) * 100).toFixed(0)}%, средняя yield за 5 лет ${ds.dividend_data?.five_yr_avg_yield != null ? (ds.dividend_data.five_yr_avg_yield * 100).toFixed(2) + '%' : '?'}.`,
      `История годовых DPS (свежие первыми): ${JSON.stringify((ds.dividend_data?.history_annual || []).slice(0, 8))}.`,
      `FCF-лет положительных: ${fm.fcf_positive_years}/${fm.fcf_available_years}; долг/EBITDA ${fm.avg_debt_ebitda != null ? fm.avg_debt_ebitda.toFixed(1) : '?'}; Piotroski ${fm.piotroski_f}/7.`,
      '',
      'Оцени: dividend_type ∈ dividend_growth|high_yield|dividend_trap_risk|special_situation|cyclical_payer|none,',
      'dividend_safety 0–10, growth_sustainability 0–10, notes (на русском).',
      'Верни ТОЛЬКО JSON: {"dividend_type":"…","dividend_safety":5,"growth_sustainability":5,"notes":"…"}',
    ].join('\n'),
  },
  divRisk: {
    system: 'Ты риск-аналитик дивидендного портфеля. Текущий год — {YEAR}. Весь текст — на русском. Отвечай только JSON.',
    user: ({ ds, fm, quality }) => [
      `Компания: ${ds.meta?.name} (${ds.meta?.ticker}). Yield ${((ds.dividend_data?.yield || 0) * 100).toFixed(2)}%, payout ${((ds.dividend_data?.payout_ratio || 0) * 100).toFixed(0)}%.`,
      `Качество: ${JSON.stringify(quality)}. Тренд выручки: ${fm.revenue_trend}, маржи: ${fm.margin_trend}.`,
      '',
      'Оцени риск среза дивиденда: cut_risk_pct 0–100 (≤15 зелёный / ≤40 жёлтый / иначе красный),',
      'yield_trap_probability 0–100, primary_risk_type (на русском), rationale (на русском).',
      'Верни ТОЛЬКО JSON: {"cut_risk_pct":20,"yield_trap_probability":15,"primary_risk_type":"…","rationale":"…"}',
    ].join('\n'),
  },
  divValuation: {
    system: 'Ты аналитик доходных инструментов. Числа дивидендов даны — интерпретируй, не изобретай свои. Текущий год — {YEAR}. Весь текст — на русском. Отвечай только JSON.',
    user: ({ ds, fm }) => [
      `Компания: ${ds.meta?.name} (${ds.meta?.ticker}), цена $${ds.meta?.current_price}, yield ${((ds.dividend_data?.yield || 0) * 100).toFixed(2)}%.`,
      `DPS $${ds.dividend_data?.annual_dps ?? '?'}; EPS: fwd ${fm.forward_eps ?? '?'} vs trail ${fm.trailing_eps ?? '?'}; CAGR3 ${((fm.revenue_cagr_3y || 0) * 100).toFixed(1)}%.`,
      `Дивидендная история: ${JSON.stringify((ds.dividend_data?.history_annual || []).slice(0, 6))}.`,
      '',
      'Оцени: yield_on_cost_3y и yield_on_cost_5y (доля, при консервативном росте DPS из истории),',
      'expected_dps_growth_rate (доля/год), total_return_estimate (доля/год: дивиденды + скромный рост цены), rationale.',
      'Верни ТОЛЬКО JSON: {"yield_on_cost_3y":0.0,"yield_on_cost_5y":0.0,"expected_dps_growth_rate":0.0,"total_return_estimate":0.0,"rationale":"…"}',
    ].join('\n'),
  },
  divPortfolio: {
    system: 'Ты советник по построению дивидендного портфеля. Текущий год — {YEAR}. Весь текст — на русском. Отвечай только JSON.',
    user: ({ ds, fm, quality, risk, valuation }) => [
      `Компания: ${ds.meta?.name} (${ds.meta?.ticker}), сектор ${ds.meta?.sector || '?'}.`,
      `Качество: ${JSON.stringify(quality)}. Риск: ${JSON.stringify(risk)}. Оценка: ${JSON.stringify(valuation)}.`,
      '',
      'Определи роль в портфеле: portfolio_role ∈ core_income|supplemental_income|growth_income|turnaround_speculation|avoid,',
      'suggested_allocation_pct (0–10), allocation_rationale (на русском).',
      'Верни ТОЛЬКО JSON: {"portfolio_role":"…","suggested_allocation_pct":3,"allocation_rationale":"…"}',
    ].join('\n'),
  },
};

module.exports = { PROMPTS };
