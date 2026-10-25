(() => {
  'use strict';

  const els = {
    workspace: document.querySelector('.workspace'),
    sourcePanel: document.getElementById('sourcePanel'),
    lyricsInput: document.getElementById('lyricsInput'),
    sourceStats: document.getElementById('sourceStats'),
    sourceLineNumbers: document.getElementById('sourceLineNumbers'),
    collapseSourceButton: document.getElementById('collapseSourceButton'),
    expandSourceButton: document.getElementById('expandSourceButton'),
    previewScroll: document.getElementById('previewScroll'),
    fillScroll: document.getElementById('fillScroll'),
    previewContent: document.getElementById('previewContent'),
    fillContent: document.getElementById('fillContent'),
    fillRatio: document.getElementById('fillRatio'),
    progressTrack: document.getElementById('progressTrack'),
    progressBar: document.getElementById('progressBar'),
    clearSourceButton: document.getElementById('clearSourceButton'),
    addCellButton: document.getElementById('addCellButton'),
    addCellLabel: document.getElementById('addCellLabel'),
    deleteCellButton: document.getElementById('deleteCellButton'),
    deleteCellLabel: document.getElementById('deleteCellLabel'),
    clearFillsButton: document.getElementById('clearFillsButton'),
    copyButton: document.getElementById('copyButton'),
    toast: document.getElementById('toast')
  };

  const fillPanel = document.querySelector('.panel-fill');

  const state = {
    rows: [],
    fills: new Map(),
    totalSlots: 0,
    filledSlots: 0
  };

  const pinyinEngine = window.pinyinPro || null;

  const graphemeSegmenter = (() => {
    if (typeof Intl === 'undefined' || typeof Intl.Segmenter !== 'function') return null;
    try {
      return new Intl.Segmenter('zh', { granularity: 'grapheme' });
    } catch (error) {
      return null;
    }
  })();

  const punctuationPattern = /^\p{P}$/u;
  const hanPattern = /^\p{Script=Han}$/u;
  const blankSegmentPattern = /^[\s\u200B\uFEFF]+$/u;
  const confirmTimers = new WeakMap();
  const confirmInfo = new WeakMap();
  const composingInputs = new WeakSet();
  const suppressNextInput = new WeakSet();
  const editableInputSelector = '#fillContent input[data-line][data-cell]';
  const finalCache = new Map();

  let toastTimer = 0;
  let sourceFrame = 0;
  let restoreFrame = 0;
  let sourceIsComposing = false;
  let activeLineIndex = null;
  let fillMode = null;
  let sourceCollapsed = false;

  /* ── Text utilities ────────────────────────────────────── */

  function splitGraphemes(value) {
    if (!value) return [];
    if (graphemeSegmenter) {
      return Array.from(graphemeSegmenter.segment(value), (part) => part.segment);
    }
    return Array.from(value);
  }

  function isPunctuation(segment) {
    return punctuationPattern.test(segment) || segment === '~' || segment === '～';
  }

  function getFinalForChar(value) {
    const char = firstVisibleGrapheme(value);
    if (!char || !hanPattern.test(char)) return '';
    if (finalCache.has(char)) return finalCache.get(char);

    let final = '';
    if (pinyinEngine && typeof pinyinEngine.pinyin === 'function') {
      try {
        const result = pinyinEngine.pinyin(char, {
          pattern: 'final',
          toneType: 'none',
          type: 'string'
        });
        if (typeof result === 'string') {
          final = result.trim().split(/\s+/)[0] || '';
        } else if (Array.isArray(result)) {
          final = String(result[0] || '').trim();
        }
        if (hanPattern.test(final)) final = '';
      } catch (error) {
        final = '';
      }
    }

    finalCache.set(char, final);
    return final;
  }

  function getRhymeTargets(row) {
    const targets = [];
    for (let index = row.tokens.length - 1; index >= 0 && targets.length < 2; index -= 1) {
      if (hanPattern.test(row.tokens[index].char)) targets.push(index);
    }
    return targets.reverse();
  }

  function firstVisibleGrapheme(value) {
    for (const segment of splitGraphemes(value)) {
      if (!blankSegmentPattern.test(segment)) return segment;
    }
    return '';
  }

  function tokenizeLine(line) {
    const tokens = [];
    for (const segment of splitGraphemes(line)) {
      if (blankSegmentPattern.test(segment)) continue;
      tokens.push({
        char: segment,
        isPunct: isPunctuation(segment)
      });
    }
    return tokens;
  }

  function normalizeNewlines(value) {
    return value.replace(/\r\n?/g, '\n');
  }

  function parseSource(raw) {
    const rawLines = normalizeNewlines(raw).split('\n');
    const parsedLines = rawLines.map((line) => tokenizeLine(line));
    const contentLineCount = parsedLines.filter((tokens) => tokens.length > 0).length;
    if (contentLineCount === 0) {
      return { rows: [], contentLineCount: 0, charCount: 0, lineCount: 0 };
    }

    const rows = [];
    let pendingBlank = false;
    let charCount = 0;

    parsedLines.forEach((tokens, sourceIndex) => {
      if (tokens.length === 0) {
        pendingBlank = true;
        return;
      }

      if (pendingBlank) {
        rows.push({ type: 'blank' });
        pendingBlank = false;
      }

      rows.push({
        type: 'line',
        sourceIndex,
        tokens
      });
      charCount += tokens.length;
    });

    // A run of blank lines at either edge still represents one visible empty line.
    if (pendingBlank) rows.push({ type: 'blank' });

    return { rows, contentLineCount, charCount, lineCount: rawLines.length };
  }

  function fillMatchKey(row) {
    return row.tokens
      .filter((token) => !token.isPunct)
      .map((token) => token.char)
      .join('\u0000');
  }

  function reconcileFills(parsed, previousRows, previousFills) {
    const available = new Map();

    previousRows.forEach((row) => {
      if (row.type !== 'line') return;
      const key = fillMatchKey(row);
      if (!available.has(key)) available.set(key, []);
      available.get(key).push({
        row,
        values: previousFills.get(row.sourceIndex) || []
      });
    });

    const nextFills = new Map();

    parsed.rows.forEach((row) => {
      if (row.type !== 'line') return;
      const key = fillMatchKey(row);
      const matches = available.get(key);
      const previous = matches && matches.length > 0 ? matches.shift() : null;
      const previousRow = previous ? previous.row : null;
      const previousValues = previous ? previous.values : [];
      const previousFillableValues = [];

      if (previousRow) {
        previousRow.tokens.forEach((token, index) => {
          if (!token.isPunct) {
            previousFillableValues.push(previousValues[index] || '');
          }
        });
      }

      const previousExtraPositions = previousRow
        ? previousRow.extraPositions || []
        : [];
      row.extraPositions = previousExtraPositions.map((position) =>
        Math.max(0, Math.min(Number(position) || 0, row.tokens.length))
      );
      const previousDeleted = previousRow
        ? previousRow.deletedSourceIndexes || []
        : [];
      row.deletedSourceIndexes = previousRow
        ? [
            ...new Set(
              previousDeleted
                .map((index) => Number(index))
                .filter(
                  (index) =>
                    Number.isInteger(index) &&
                    index >= 0 &&
                    index < row.tokens.length
                )
            )
          ]
        : [];
      let fillableIndex = 0;

      const nextValues = row.tokens.map((token, index) => {
        if (token.isPunct) {
          const previousToken = previousRow ? previousRow.tokens[index] : null;
          const previousValue = previousValues[index];
          if (
            previousToken &&
            previousToken.isPunct &&
            typeof previousValue === 'string' &&
            previousValue &&
            previousValue !== previousToken.char
          ) {
            return firstVisibleGrapheme(previousValue);
          }
          return token.char;
        }

        const previousValue = previousFillableValues[fillableIndex];
        fillableIndex += 1;
        return typeof previousValue === 'string'
          ? firstVisibleGrapheme(previousValue)
          : '';
      });

      if (previousRow) {
        const extraStart = previousRow.tokens.length;
        row.extraPositions.forEach((position, index) => {
          const value = previousValues[extraStart + index] || '';
          nextValues.push(firstVisibleGrapheme(value));
        });
      }

      nextFills.set(row.sourceIndex, nextValues);
    });

    return nextFills;
  }

  /* ── Source rendering ──────────────────────────────────── */

  function renderSourceStats(parsed) {
    els.sourceStats.innerHTML =
      `<strong>${parsed.lineCount}</strong> 行 <i></i> ` +
      `<strong>${parsed.charCount}</strong> 字`;
  }

  function renderSourceLineNumbers() {
    const lineCount = Math.max(1, els.lyricsInput.value.split('\n').length);
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < lineCount; index += 1) {
      const number = document.createElement('div');
      number.className = 'source-line-number';
      number.textContent = index < 9 ? `0${index + 1}` : String(index + 1);
      fragment.append(number);
    }
    els.sourceLineNumbers.replaceChildren(fragment);
    updateCurrentSourceLine();
    syncSourceLineNumbers();
  }

  function syncSourceLineNumbers() {
    els.sourceLineNumbers.style.transform =
      `translateY(${-els.lyricsInput.scrollTop}px)`;
  }

  function updateCurrentSourceLine() {
    if (document.activeElement !== els.lyricsInput) return;

    const caret = els.lyricsInput.selectionStart || 0;
    const prefix = els.lyricsInput.value.slice(0, caret);
    const lineIndex = prefix.split('\n').length - 1;
    Array.from(els.sourceLineNumbers.children).forEach((number, index) => {
      number.classList.toggle('is-current', index === lineIndex);
    });
  }

  function render(options = {}) {
    const preserveScroll = options.preserveScroll !== false;
    const resetScroll = options.resetScroll === true;
    const oldScrollTop = preserveScroll ? els.fillScroll.scrollTop : 0;
    const oldScrollLeft = preserveScroll ? els.fillScroll.scrollLeft : 0;
    const parsed = parseSource(els.lyricsInput.value);
    const previousRows = state.rows;
    const previousFills = state.fills;

    state.rows = parsed.rows;
    state.fills = reconcileFills(parsed, previousRows, previousFills);

    renderSourceStats(parsed);
    renderSourceLineNumbers();
    renderBoards();
    restoreActiveLine();

    els.clearSourceButton.disabled = els.lyricsInput.value.length === 0;
    updateCopyButton();
    updateProgress();
    updateFillModeButtons();
    syncFillInputsForMode();

    clearTimeout(restoreFrame);
    restoreFrame = window.setTimeout(() => {
      applyScroll(
        resetScroll ? 0 : oldScrollTop,
        resetScroll ? 0 : oldScrollLeft
      );
    }, 0);
  }

  function renderBoards() {
    const previewFragment = document.createDocumentFragment();
    const fillFragment = document.createDocumentFragment();
    const hasContent = state.rows.length > 0;

    if (!hasContent) {
      previewFragment.append(createEmptyState('preview'));
      fillFragment.append(createEmptyState('fill'));
    } else {
      state.rows.forEach((row, index) => {
        if (row.type === 'blank') {
          previewFragment.append(createBlankRow('preview'));
          fillFragment.append(createBlankRow('fill'));
          return;
        }

        const displayNumber = index + 1;
        previewFragment.append(createLyricRow(row, displayNumber, 'preview'));
        fillFragment.append(createLyricRow(row, displayNumber, 'fill'));
      });
    }

    els.previewContent.replaceChildren(previewFragment);
    els.fillContent.replaceChildren(fillFragment);
  }

  function createEmptyState(kind) {
    const wrapper = document.createElement('div');
    wrapper.className = 'empty-state';

    const illustration = document.createElement('div');
    if (kind === 'preview') {
      illustration.className = 'empty-illustration lines-glyph';
      illustration.setAttribute('aria-hidden', 'true');
      for (let i = 0; i < 3; i += 1) illustration.append(document.createElement('span'));
    } else {
      illustration.className = 'empty-illustration grid-glyph';
      illustration.setAttribute('aria-hidden', 'true');
      for (let i = 0; i < 9; i += 1) illustration.append(document.createElement('i'));
    }

    const title = document.createElement('h3');
    const description = document.createElement('p');
    const hint = document.createElement('span');
    hint.className = 'empty-hint';

    if (kind === 'preview') {
      title.textContent = '原词，逐字成列';
      description.textContent = '左侧输入歌词后，这里会逐字呈现原文；末二字上方显示韵母，方便对照。';
      hint.textContent = 'REFERENCE · 原文';
    } else {
      title.textContent = '在这里逐字填词';
      description.textContent = '每一格对应原词的一个字。标点已自动落格，也可直接修改；填完会自动跳到下一格。';
      hint.textContent = 'COMPOSE · 可填写';
    }

    wrapper.append(illustration, title, description, hint);
    return wrapper;
  }

  function createBlankRow(mode) {
    const row = document.createElement('div');
    row.className = 'lyric-row is-blank';
    row.dataset.mode = mode;
    row.setAttribute('role', 'separator');
    row.setAttribute('aria-label', '空行');

    const number = document.createElement('span');
    number.className = 'line-number';
    number.setAttribute('aria-hidden', 'true');

    const rule = document.createElement('div');
    rule.className = 'blank-rule';
    rule.setAttribute('aria-hidden', 'true');

    row.append(number, rule);
    return row;
  }

  function createRhymeNote(value) {
    const note = document.createElement('span');
    note.className = 'rhyme-note';
    setRhymeNote(note, value);
    return note;
  }

  function setRhymeNote(note, value) {
    const final = getFinalForChar(value);
    note.textContent = final;
    note.title = final ? `韵母：${final}` : '';
    note.classList.toggle('is-empty', !final);
  }

  function createReferenceCell(row, token, cellIndex, displayNumber, showRhyme) {
    const cell = document.createElement('div');
    cell.className = 'char-cell reference-cell is-filled';
    cell.dataset.line = String(row.sourceIndex);
    cell.dataset.cell = String(cellIndex);
    cell.title = `第 ${displayNumber} 行 · 第 ${cellIndex + 1} 格`;
    if (token.isPunct) cell.classList.add('is-punct');

    const glyph = document.createElement('span');
    glyph.className = 'glyph';
    glyph.textContent = token.char;
    cell.append(glyph);

    if (showRhyme) cell.append(createRhymeNote(token.char));
    return cell;
  }

  function createFillCell(row, cellIndex, value, options) {
    const { displayNumber, isPunct, isExtra, showRhyme } = options;
    const cell = document.createElement('div');
    cell.className = 'char-cell editor-cell';
    cell.dataset.line = String(row.sourceIndex);
    cell.dataset.cell = String(cellIndex);
    if (isPunct) cell.classList.add('is-punct');
    if (isExtra) cell.classList.add('is-extra');
    if (value) cell.classList.add('is-filled');

    cell.title = isExtra
      ? `第 ${displayNumber} 行 · 新增格`
      : isPunct
        ? `第 ${displayNumber} 行 · 第 ${cellIndex + 1} 格 · 标点，可修改`
        : `第 ${displayNumber} 行 · 第 ${cellIndex + 1} 格`;

    const input = document.createElement('input');
    input.type = 'text';
    input.autocomplete = 'off';
    input.autocapitalize = 'off';
    input.spellcheck = false;
    input.value = value;
    input.dataset.line = String(row.sourceIndex);
    input.dataset.cell = String(cellIndex);
    if (isPunct) input.dataset.punct = 'true';
    if (isExtra) input.dataset.extra = 'true';
    input.setAttribute(
      'aria-label',
      `第 ${displayNumber} 行，第 ${cellIndex + 1} 格` +
        (isPunct ? '，标点，可修改' : isExtra ? '，新增格' : '')
    );
    cell.append(input);

    if (showRhyme) cell.append(createRhymeNote(value));
    return cell;
  }

  function getExtraCount(row) {
    return (row.extraPositions || []).length;
  }

  function getDeletedSourceIndexes(row) {
    return new Set(row.deletedSourceIndexes || []);
  }

  function getVisibleSourceCount(row) {
    return row.tokens.length - getDeletedSourceIndexes(row).size;
  }

  function getVisibleCellCount(row) {
    return getVisibleSourceCount(row) + getExtraCount(row);
  }

  function appendDeleteHandle(cell, lineIndex, cellIndex, displayNumber, isExtra) {
    const handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'delete-handle';
    handle.dataset.line = String(lineIndex);
    handle.dataset.cell = String(cellIndex);
    const label = isExtra
      ? `删除第 ${displayNumber} 行的新增格`
      : `删除第 ${displayNumber} 行、第 ${cellIndex + 1} 格`;
    handle.title = label;
    handle.setAttribute('aria-label', label);
    cell.append(handle);
  }

  function appendInsertHandle(cell, lineIndex, displayNumber, target) {
    const handle = document.createElement('button');
    handle.type = 'button';
    handle.className = `insert-handle${target.isEnd ? ' is-end' : ''}`;
    handle.dataset.line = String(lineIndex);
    handle.dataset.kind = target.kind;

    let label = '';
    if (target.kind === 'extra') {
      handle.dataset.extraIndex = String(target.extraIndex);
      label = `在第 ${displayNumber} 行新增格前插入新格`;
    } else {
      handle.dataset.boundary = String(target.boundary);
      label = target.isEnd
        ? `在第 ${displayNumber} 行末尾插入新格`
        : `在第 ${displayNumber} 行、第 ${target.boundary + 1} 格前插入新格`;
    }

    handle.title = label;
    handle.setAttribute('aria-label', label);
    cell.append(handle);
  }

  function createLyricRow(row, displayNumber, mode) {
    const values = state.fills.get(row.sourceIndex) || [];
    const lineState = getLineState(row, values);
    const totalCellCount =
      mode === 'fill'
        ? getVisibleCellCount(row)
        : row.tokens.length;
    const rhymeTargets = new Set(getRhymeTargets(row));
    const rowElement = document.createElement('div');
    rowElement.className = 'lyric-row';
    rowElement.dataset.line = String(row.sourceIndex);
    rowElement.dataset.mode = mode;
    if (mode === 'fill' && lineState.complete) rowElement.classList.add('is-complete');
    rowElement.setAttribute('role', 'group');
    rowElement.setAttribute(
      'aria-label',
      `第 ${displayNumber} 行，共 ${totalCellCount} 格`
    );

    const number = document.createElement('span');
    number.className = 'line-number';
    number.textContent = displayNumber < 10 ? `0${displayNumber}` : String(displayNumber);
    number.setAttribute('aria-hidden', 'true');

    const cells = document.createElement('div');
    cells.className = 'cells';

    if (mode === 'preview') {
      row.tokens.forEach((token, cellIndex) => {
        cells.append(
          createReferenceCell(
            row,
            token,
            cellIndex,
            displayNumber,
            rhymeTargets.has(cellIndex)
          )
        );
      });
    } else {
      getFillCellOrder(row).forEach((entry) => {
        const { cellIndex, token, isExtra } = entry;
        const value = isExtra
          ? values[cellIndex] || ''
          : typeof values[cellIndex] === 'string'
            ? values[cellIndex]
            : token.isPunct
              ? token.char
              : '';

        const cell = createFillCell(row, cellIndex, value, {
          displayNumber,
          isPunct: Boolean(token && token.isPunct),
          isExtra,
          showRhyme: rhymeTargets.has(cellIndex)
        });

        appendInsertHandle(
          cell,
          row.sourceIndex,
          displayNumber,
          isExtra
            ? { kind: 'extra', extraIndex: entry.extraIndex }
            : { kind: 'source', boundary: cellIndex }
        );
        appendDeleteHandle(
          cell,
          row.sourceIndex,
          cellIndex,
          displayNumber,
          isExtra
        );
        cells.append(cell);
      });

      if (cells.lastElementChild) {
        appendInsertHandle(
          cells.lastElementChild,
          row.sourceIndex,
          displayNumber,
          {
            kind: 'end',
            boundary: row.tokens.length,
            isEnd: true
          }
        );
      }
    }

    rowElement.append(number, cells);
    return rowElement;
  }

  function getLineState(row, values) {
    let total = 0;
    let filled = 0;
    const deleted = getDeletedSourceIndexes(row);

    row.tokens.forEach((token, index) => {
      if (deleted.has(index) || token.isPunct) return;
      total += 1;
      if (values[index]) filled += 1;
    });

    for (let index = 0; index < getExtraCount(row); index += 1) {
      const valueIndex = row.tokens.length + index;
      total += 1;
      if (values[valueIndex]) filled += 1;
    }

    return {
      total,
      filled,
      complete: total > 0 && filled === total
    };
  }

  function getFillCellOrder(row) {
    const order = [];
    const extraPositions = row.extraPositions || [];
    const deleted = getDeletedSourceIndexes(row);
    const tokenCount = row.tokens.length;

    for (let boundary = 0; boundary <= tokenCount; boundary += 1) {
      extraPositions.forEach((position, extraIndex) => {
        if (position === boundary) {
          order.push({
            cellIndex: tokenCount + extraIndex,
            token: null,
            isExtra: true,
            extraIndex
          });
        }
      });

      if (boundary < tokenCount && !deleted.has(boundary)) {
        order.push({
          cellIndex: boundary,
          token: row.tokens[boundary],
          isExtra: false
        });
      }
    }

    return order;
  }

  /* ── Live fill state ───────────────────────────────────── */

  function applyCellValue(input, value) {
    const lineIndex = Number(input.dataset.line);
    const cellIndex = Number(input.dataset.cell);
    const values = state.fills.get(lineIndex);
    if (!values) return;

    values[cellIndex] = value;
    input.value = value;

    const cell = input.closest('.char-cell');
    if (cell) {
      cell.classList.toggle('is-filled', Boolean(value));
      const note = cell.querySelector('.rhyme-note');
      if (note) setRhymeNote(note, value);
    }

    updateLineCompletion(lineIndex);
    updateProgress();
  }

  function updateLineCompletion(lineIndex) {
    const row = state.rows.find(
      (item) => item.type === 'line' && item.sourceIndex === lineIndex
    );
    if (!row) return;

    const values = state.fills.get(lineIndex) || [];
    const lineState = getLineState(row, values);
    const rows = document.querySelectorAll(
      `.lyric-row[data-mode="fill"][data-line="${lineIndex}"]`
    );
    rows.forEach((element) => element.classList.toggle('is-complete', lineState.complete));
  }

  function getProgress() {
    let total = 0;
    let filled = 0;

    state.rows.forEach((row) => {
      if (row.type !== 'line') return;
      const values = state.fills.get(row.sourceIndex) || [];
      const lineState = getLineState(row, values);
      total += lineState.total;
      filled += lineState.filled;
    });

    return { total, filled };
  }

  function updateProgress() {
    const { total, filled } = getProgress();
    state.totalSlots = total;
    state.filledSlots = filled;

    els.fillRatio.textContent = `${filled} / ${total}`;
    els.progressBar.style.width = total > 0 ? `${(filled / total) * 100}%` : '0%';
    els.progressTrack.setAttribute('aria-valuemax', String(total));
    els.progressTrack.setAttribute('aria-valuenow', String(filled));
    els.progressTrack.setAttribute(
      'aria-valuetext',
      total > 0 ? `已填 ${filled} 字，共 ${total} 字` : '暂无可填字格'
    );
    els.progressTrack.classList.toggle('is-complete', total > 0 && filled === total);
    els.clearFillsButton.disabled = !hasFillChanges();
  }

  function hasFillChanges() {
    for (const row of state.rows) {
      if (row.type !== 'line') continue;
      if (
        getExtraCount(row) > 0 ||
        (row.deletedSourceIndexes || []).length > 0
      ) {
        return true;
      }
      const values = state.fills.get(row.sourceIndex) || [];
      const cellCount = row.tokens.length;
      for (let index = 0; index < cellCount; index += 1) {
        const token = index < row.tokens.length ? row.tokens[index] : null;
        if (token && token.isPunct) {
          if ((values[index] ?? token.char) !== token.char) return true;
        } else if (values[index]) {
          return true;
        }
      }
    }
    return false;
  }

  function updateCopyButton() {
    els.copyButton.disabled = !state.rows.some((row) => row.type === 'line');
  }

  function getLineRow(lineIndex) {
    return (
      state.rows.find(
        (row) => row.type === 'line' && row.sourceIndex === lineIndex
      ) || null
    );
  }

  function setActiveLine(lineIndex) {
    activeLineIndex = Number.isFinite(lineIndex) ? lineIndex : null;
    document
      .querySelectorAll('.lyric-row.is-active')
      .forEach((row) => row.classList.remove('is-active'));

    if (activeLineIndex !== null && getLineRow(activeLineIndex)) {
      document
        .querySelectorAll(`.lyric-row[data-line="${activeLineIndex}"]`)
        .forEach((row) => row.classList.add('is-active'));
    }

    updateFillModeButtons();
  }

  function restoreActiveLine() {
    if (activeLineIndex !== null && !getLineRow(activeLineIndex)) {
      activeLineIndex = null;
    }
    if (activeLineIndex !== null) {
      document
        .querySelectorAll(`.lyric-row[data-line="${activeLineIndex}"]`)
        .forEach((row) => row.classList.add('is-active'));
    }
  }

  function hasContentLines() {
    return state.rows.some((row) => row.type === 'line');
  }

  function updateFillModeButtons() {
    const hasContent = hasContentLines();
    if (!hasContent) fillMode = null;

    const isAdding = fillMode === 'add';
    const isDeleting = fillMode === 'delete';

    els.addCellButton.disabled = !hasContent;
    els.deleteCellButton.disabled = !hasContent;
    els.addCellButton.classList.toggle('is-active', isAdding);
    els.deleteCellButton.classList.toggle('is-active', isDeleting);
    fillPanel.classList.toggle('is-adding', isAdding);
    fillPanel.classList.toggle('is-deleting', isDeleting);

    els.addCellLabel.textContent = isAdding ? '取消加格' : '增加格子';
    els.deleteCellLabel.textContent = isDeleting ? '取消删格' : '删格';

    els.addCellButton.title = isAdding
      ? '退出加格模式'
      : hasContent
        ? '选择要插入格子的位置'
        : '输入原词后可增加格子';
    els.addCellButton.setAttribute(
      'aria-label',
      isAdding ? '取消增加格子' : '增加格子，选择插入位置'
    );

    els.deleteCellButton.title = isDeleting
      ? '退出删格模式'
      : hasContent
        ? '选择要删除的格子'
        : '输入原词后可删除格子';
    els.deleteCellButton.setAttribute(
      'aria-label',
      isDeleting ? '取消删除格子' : '选择要删除的格子'
    );
  }

  function syncFillInputsForMode() {
    const locked = fillMode !== null;
    els.fillContent.querySelectorAll('input').forEach((input) => {
      input.readOnly = locked;
      input.tabIndex = locked ? -1 : 0;
    });
  }

  function setFillMode(mode, options = {}) {
    const nextMode = mode === 'add' || mode === 'delete' ? mode : null;
    if (nextMode && !hasContentLines()) return;
    if (nextMode === fillMode) {
      updateFillModeButtons();
      return;
    }

    fillMode = nextMode;
    if (fillMode) {
      if (
        document.activeElement &&
        document.activeElement.matches('#fillContent input')
      ) {
        document.activeElement.blur();
      }
      setActiveLine(null);
    }

    updateFillModeButtons();
    syncFillInputsForMode();

    if (fillMode === 'add' && !options.silent) {
      showToast('点击格子之间的 + 选择插入位置');
    } else if (fillMode === 'delete' && !options.silent) {
      showToast('点击要删除的格子');
    }
  }

  function focusNearCell(lineIndex, cellIndex) {
    const inputs = Array.from(
      els.fillContent.querySelectorAll(`input[data-line="${lineIndex}"]`)
    );
    if (inputs.length === 0) return;

    const target =
      inputs.find((input) => Number(input.dataset.cell) >= cellIndex) ||
      inputs[inputs.length - 1];
    target.focus();
    target.select();
    setActiveLine(lineIndex);
  }

  function deleteFillCell(lineIndex, cellIndex) {
    const row = getLineRow(lineIndex);
    if (!row) return;
    if (getVisibleCellCount(row) <= 1) {
      showToast('每行至少保留一格', true);
      return;
    }

    const displayNumber = state.rows.indexOf(row) + 1;
    if (cellIndex >= row.tokens.length) {
      const extraIndex = cellIndex - row.tokens.length;
      const positions = row.extraPositions || [];
      if (extraIndex < 0 || extraIndex >= positions.length) return;
      positions.splice(extraIndex, 1);
      const values = state.fills.get(lineIndex) || [];
      values.splice(cellIndex, 1);
      state.fills.set(lineIndex, values);
    } else {
      const deleted = new Set(row.deletedSourceIndexes || []);
      if (deleted.has(cellIndex)) return;
      deleted.add(cellIndex);
      row.deletedSourceIndexes = [...deleted].sort((a, b) => a - b);
    }

    setFillMode(null, { silent: true });
    render({ preserveScroll: true });
    window.requestAnimationFrame(() => focusNearCell(lineIndex, cellIndex));
    showToast(`第 ${displayNumber} 行已删除一格`);
  }

  function finishCellInsertion(lineIndex, displayNumber, cellIndex) {
    setFillMode(null, { silent: true });
    render({ preserveScroll: true });

    window.requestAnimationFrame(() => {
      const target = els.fillContent.querySelector(
        `input[data-line="${lineIndex}"][data-cell="${cellIndex}"]`
      );
      if (target) {
        target.focus();
        target.select();
      }
      setActiveLine(lineIndex);
    });

    showToast(`第 ${displayNumber} 行已插入一格`);
  }

  function insertCellAtBoundary(lineIndex, boundary) {
    const row = getLineRow(lineIndex);
    if (!row) return;

    const clampedBoundary = Math.max(
      0,
      Math.min(Number(boundary) || 0, row.tokens.length)
    );
    if (!Array.isArray(row.extraPositions)) row.extraPositions = [];
    row.extraPositions.push(clampedBoundary);

    const displayNumber = state.rows.indexOf(row) + 1;
    const cellIndex = row.tokens.length + row.extraPositions.length - 1;
    const values = state.fills.get(lineIndex) || [];
    while (values.length <= cellIndex) values.push('');
    state.fills.set(lineIndex, values);

    finishCellInsertion(lineIndex, displayNumber, cellIndex);
  }

  function insertCellBeforeExtra(lineIndex, extraIndex) {
    const row = getLineRow(lineIndex);
    if (!row) return;

    const positions = row.extraPositions || [];
    if (!Number.isInteger(extraIndex) || extraIndex < 0 || extraIndex >= positions.length) {
      return;
    }

    const displayNumber = state.rows.indexOf(row) + 1;
    const boundary = positions[extraIndex];
    positions.splice(extraIndex, 0, boundary);

    const cellIndex = row.tokens.length + extraIndex;
    const values = state.fills.get(lineIndex) || [];
    values.splice(cellIndex, 0, '');
    state.fills.set(lineIndex, values);

    finishCellInsertion(lineIndex, displayNumber, cellIndex);
  }

  function isPunctuationInput(input) {
    const cell = input.closest('.char-cell');
    return Boolean(cell && cell.classList.contains('is-punct'));
  }

  function focusNextEditable(input) {
    const inputs = Array.from(els.fillContent.querySelectorAll(editableInputSelector));
    const currentIndex = inputs.indexOf(input);
    if (currentIndex < 0) return;

    for (let index = currentIndex + 1; index < inputs.length; index += 1) {
      if (!isPunctuationInput(inputs[index])) {
        inputs[index].focus();
        inputs[index].select();
        return;
      }
    }
  }

  function focusAdjacentEditable(input, direction) {
    const inputs = Array.from(els.fillContent.querySelectorAll(editableInputSelector));
    const currentIndex = inputs.indexOf(input);
    const target = inputs[currentIndex + direction];
    if (target) {
      target.focus();
      target.select();
    }
  }

  function valueFromInput(input) {
    const value = firstVisibleGrapheme(input.value);
    if (input.value !== value) input.value = value;
    return value;
  }

  function handleFillInput(event) {
    if (fillMode) return;
    const input = event.target.closest('input');
    if (!input || !els.fillContent.contains(input)) return;
    if (composingInputs.has(input)) return;

    if (suppressNextInput.has(input)) {
      suppressNextInput.delete(input);
      return;
    }

    const value = valueFromInput(input);
    applyCellValue(input, value);
    if (value && !isPunctuationInput(input)) focusNextEditable(input);
  }

  function handleCompositionStart(event) {
    const input = event.target.closest('input');
    if (input && els.fillContent.contains(input)) {
      composingInputs.add(input);
    }
  }

  function handleCompositionEnd(event) {
    const input = event.target.closest('input');
    if (!input || !els.fillContent.contains(input)) return;

    composingInputs.delete(input);
    const value = valueFromInput(input);
    applyCellValue(input, value);

    // Some browsers dispatch one final input event after compositionend.
    suppressNextInput.add(input);
    window.setTimeout(() => suppressNextInput.delete(input), 0);

    if (value && !isPunctuationInput(input)) focusNextEditable(input);
  }

  function handleFillKeydown(event) {
    if (fillMode) return;
    const input = event.target.closest('input');
    if (!input || !els.fillContent.contains(input)) return;
    if (event.isComposing || composingInputs.has(input)) return;

    if (event.key === 'Backspace') {
      event.preventDefault();
      if (input.value) {
        applyCellValue(input, '');
        return;
      }

      if (isPunctuationInput(input)) return;

      const inputs = Array.from(
        els.fillContent.querySelectorAll(editableInputSelector)
      );
      const currentIndex = inputs.indexOf(input);
      for (let index = currentIndex - 1; index >= 0; index -= 1) {
        if (!isPunctuationInput(inputs[index])) {
          inputs[index].focus();
          inputs[index].select();
          applyCellValue(inputs[index], '');
          return;
        }
      }
      return;
    }

    if (event.key === 'Delete') {
      event.preventDefault();
      applyCellValue(input, '');
      return;
    }

    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      focusAdjacentEditable(input, -1);
      return;
    }

    if (event.key === 'ArrowRight') {
      event.preventDefault();
      focusAdjacentEditable(input, 1);
    }
  }

  function handleFillFocusIn(event) {
    if (fillMode) return;
    const input = event.target.closest('input');
    if (!input || !els.fillContent.contains(input)) return;
    const cell = input.closest('.char-cell');
    if (cell) cell.classList.add('is-focused');
    setActiveLine(Number(input.dataset.line));
  }

  function handleFillFocusOut(event) {
    const input = event.target.closest('input');
    if (!input) return;
    const cell = input.closest('.char-cell');
    if (cell) cell.classList.remove('is-focused');
  }

  function handlePaste(event) {
    if (fillMode) return;
    const input = event.target.closest('input');
    if (!input || !els.fillContent.contains(input)) return;

    const clipboardText = event.clipboardData
      ? event.clipboardData.getData('text/plain')
      : '';

    const pieces = splitGraphemes(clipboardText).filter(
      (segment) => !blankSegmentPattern.test(segment)
    );
    if (pieces.length === 0) return;

    event.preventDefault();

    if (isPunctuationInput(input)) {
      applyCellValue(input, pieces[0]);
      if (pieces.length > 1) showToast('标点格只填入第一个字');
      return;
    }

    const lineIndex = Number(input.dataset.line);
    const lineInputs = Array.from(
      els.fillContent.querySelectorAll(
        `input[data-line="${lineIndex}"][data-cell]`
      )
    ).filter((lineInput) => !isPunctuationInput(lineInput));
    const startIndex = lineInputs.indexOf(input);
    if (startIndex < 0) return;

    let cursor = startIndex;
    pieces.forEach((segment) => {
      if (cursor >= lineInputs.length) return;
      applyCellValue(lineInputs[cursor], segment);
      cursor += 1;
    });

    if (cursor < lineInputs.length) {
      lineInputs[cursor].focus();
    } else {
      lineInputs[lineInputs.length - 1].focus();
    }

    if (pieces.length > lineInputs.length - startIndex) {
      showToast('超出行字数的内容未填入');
    }
  }

  /* ── Scroll sync ───────────────────────────────────────── */

  function handleScroll(event) {
    const source = event.currentTarget;
    const target =
      source === els.previewScroll ? els.fillScroll : els.previewScroll;
    const sourceTop = source.scrollTop;
    const sourceLeft = source.scrollLeft;

    // Comparing positions instead of using a time lock keeps quick direction
    // changes responsive while still preventing a scroll-event feedback loop.
    if (Math.abs(target.scrollTop - sourceTop) > 0.5) {
      target.scrollTop = sourceTop;
    }
    if (Math.abs(target.scrollLeft - sourceLeft) > 0.5) {
      target.scrollLeft = sourceLeft;
    }
  }

  function applyScroll(top, left = 0) {
    const maxTop = Math.max(
      0,
      els.fillScroll.scrollHeight - els.fillScroll.clientHeight
    );
    const maxLeft = Math.max(
      0,
      els.fillScroll.scrollWidth - els.fillScroll.clientWidth
    );
    const nextTop = Math.max(0, Math.min(top, maxTop));
    const nextLeft = Math.max(0, Math.min(left, maxLeft));

    els.fillScroll.scrollTop = nextTop;
    els.previewScroll.scrollTop = nextTop;
    els.fillScroll.scrollLeft = nextLeft;
    els.previewScroll.scrollLeft = nextLeft;
  }

  /* ── Actions ───────────────────────────────────────────── */

  function setSourceCollapsed(collapsed, options = {}) {
    const nextCollapsed = Boolean(collapsed);
    if (nextCollapsed === sourceCollapsed) return;
    sourceCollapsed = nextCollapsed;

    els.workspace.classList.toggle('is-source-collapsed', sourceCollapsed);
    els.sourcePanel.setAttribute('aria-hidden', String(sourceCollapsed));
    els.collapseSourceButton.setAttribute(
      'aria-expanded',
      String(!sourceCollapsed)
    );
    els.expandSourceButton.setAttribute(
      'aria-expanded',
      String(!sourceCollapsed)
    );

    window.requestAnimationFrame(() => {
      applyScroll(els.fillScroll.scrollTop, els.fillScroll.scrollLeft);
      if (sourceCollapsed) {
        els.expandSourceButton.focus();
      } else if (options.focus !== false) {
        els.lyricsInput.focus();
      }
    });
  }

  function showToast(message, isError = false) {
    window.clearTimeout(toastTimer);
    els.toast.textContent = message;
    els.toast.classList.toggle('is-error', isError);
    els.toast.classList.add('is-visible');

    toastTimer = window.setTimeout(() => {
      els.toast.classList.remove('is-visible');
    }, 2800);
  }

  function resetConfirmButton(button) {
    const info = confirmInfo.get(button);
    const timer = confirmTimers.get(button);
    if (timer) window.clearTimeout(timer);
    if (!info) return;

    button.classList.remove('is-confirming');
    delete button.dataset.confirming;
    if (info.labelElement && info.originalLabel !== null) {
      info.labelElement.textContent = info.originalLabel;
    }
    if (info.originalTitle !== null) button.title = info.originalTitle;
    confirmInfo.delete(button);
    confirmTimers.delete(button);
  }

  function requestConfirmation(button, options) {
    if (confirmInfo.has(button)) {
      resetConfirmButton(button);
      options.onConfirm();
      return;
    }

    const labelElement = options.labelElement || null;
    const info = {
      labelElement,
      originalLabel: labelElement ? labelElement.textContent : null,
      originalTitle: button.title || null
    };

    confirmInfo.set(button, info);
    button.classList.add('is-confirming');
    button.dataset.confirming = 'true';
    if (labelElement && options.confirmLabel) {
      labelElement.textContent = options.confirmLabel;
    }
    if (options.confirmTitle) button.title = options.confirmTitle;

    const timer = window.setTimeout(() => resetConfirmButton(button), 3200);
    confirmTimers.set(button, timer);
    showToast(options.message);
  }

  function clearSource() {
    if (!els.lyricsInput.value.length) return;

    requestConfirmation(els.clearSourceButton, {
      labelElement: els.clearSourceButton,
      confirmLabel: '确认清空',
      message: '再次点击「确认清空」将清除原词与填词',
      onConfirm: () => {
        resetConfirmButton(els.clearSourceButton);
        setFillMode(null, { silent: true });
        els.lyricsInput.value = '';
        state.fills = new Map();
        setActiveLine(null);
        render({ resetScroll: true });
        resetConfirmButton(els.clearSourceButton);
        resetConfirmButton(els.clearFillsButton);
        els.lyricsInput.focus();
        showToast('原词已清空');
      }
    });
  }

  function clearFills() {
    if (!hasFillChanges()) return;

    requestConfirmation(els.clearFillsButton, {
      confirmTitle: '再次点击确认重置',
      message: '再次点击「重置」以恢复全部格子并清空填词',
      onConfirm: () => {
        resetConfirmButton(els.clearFillsButton);
        setFillMode(null, { silent: true });
        state.fills.forEach((values, lineIndex) => {
          const row = getLineRow(lineIndex);
          if (!row) return;
          row.extraPositions = [];
          row.deletedSourceIndexes = [];
          values.length = row.tokens.length;
          row.tokens.forEach((token, index) => {
            values[index] = token.isPunct ? token.char : '';
          });
        });
        render({ preserveScroll: true });
        showToast('填词与格子已重置');
      }
    });
  }

  function getCopyText() {
    return state.rows
      .map((row) => {
        if (row.type === 'blank') return '';
        const values = state.fills.get(row.sourceIndex) || [];
        let line = '';

        getFillCellOrder(row).forEach((entry) => {
          const value = values[entry.cellIndex] || '';
          if (!entry.isExtra && entry.token && entry.token.isPunct) {
            line += value;
          } else {
            line += value || '□';
          }
        });

        return line;
      })
      .join('\n');
  }

  async function copyResult() {
    if (!state.rows.some((row) => row.type === 'line')) return;

    const text = getCopyText();
    const complete = state.totalSlots === 0 || state.filledSlots === state.totalSlots;

    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        copyWithFallback(text);
      }
      showToast(complete ? '填词已复制' : '已复制，未填字位以 □ 标记');
    } catch (error) {
      try {
        copyWithFallback(text);
        showToast(complete ? '填词已复制' : '已复制，未填字位以 □ 标记');
      } catch (fallbackError) {
        showToast('复制失败，请手动选择文字', true);
      }
    }
  }

  function copyWithFallback(text) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.top = '-1000px';
    textarea.style.opacity = '0';
    document.body.append(textarea);
    textarea.select();
    const successful = document.execCommand('copy');
    textarea.remove();
    if (!successful) throw new Error('copy failed');
  }

  /* ── Events ────────────────────────────────────────────── */

  function scheduleSourceRender() {
    if (sourceFrame) window.cancelAnimationFrame(sourceFrame);
    setActiveLine(null);
    setFillMode(null, { silent: true });
    sourceFrame = window.requestAnimationFrame(() => {
      sourceFrame = 0;
      render({ preserveScroll: true });
      resetConfirmButton(els.clearSourceButton);
      resetConfirmButton(els.clearFillsButton);
    });
  }

  els.lyricsInput.addEventListener('compositionstart', () => {
    sourceIsComposing = true;
  });

  els.lyricsInput.addEventListener('compositionend', () => {
    sourceIsComposing = false;
    scheduleSourceRender();
  });

  els.lyricsInput.addEventListener('input', () => {
    updateCurrentSourceLine();
    if (sourceIsComposing) return;
    scheduleSourceRender();
  });

  els.lyricsInput.addEventListener('scroll', syncSourceLineNumbers, {
    passive: true
  });

  els.lyricsInput.addEventListener('focus', updateCurrentSourceLine);
  els.lyricsInput.addEventListener('click', updateCurrentSourceLine);
  els.lyricsInput.addEventListener('keyup', updateCurrentSourceLine);
  els.lyricsInput.addEventListener('select', updateCurrentSourceLine);
  els.lyricsInput.addEventListener('blur', () => {
    els.sourceLineNumbers
      .querySelectorAll('.is-current')
      .forEach((number) => number.classList.remove('is-current'));
  });

  els.fillContent.addEventListener('input', handleFillInput);
  els.fillContent.addEventListener('compositionstart', handleCompositionStart);
  els.fillContent.addEventListener('compositionend', handleCompositionEnd);
  els.fillContent.addEventListener('keydown', handleFillKeydown);
  els.fillContent.addEventListener('focusin', handleFillFocusIn);
  els.fillContent.addEventListener('focusout', handleFillFocusOut);
  els.fillContent.addEventListener('paste', handlePaste);
  els.fillContent.addEventListener('click', (event) => {
    const deleteHandle = event.target.closest('.delete-handle');
    if (deleteHandle) {
      if (fillMode !== 'delete') return;
      event.preventDefault();
      event.stopPropagation();
      deleteFillCell(
        Number(deleteHandle.dataset.line),
        Number(deleteHandle.dataset.cell)
      );
      return;
    }

    const insertHandle = event.target.closest('.insert-handle');
    if (!insertHandle || fillMode !== 'add') return;
    event.preventDefault();
    event.stopPropagation();

    const lineIndex = Number(insertHandle.dataset.line);
    if (insertHandle.dataset.kind === 'extra') {
      insertCellBeforeExtra(lineIndex, Number(insertHandle.dataset.extraIndex));
    } else {
      insertCellAtBoundary(lineIndex, Number(insertHandle.dataset.boundary));
    }
  });

  els.previewScroll.addEventListener('scroll', handleScroll, { passive: true });
  els.fillScroll.addEventListener('scroll', handleScroll, { passive: true });

  els.clearSourceButton.addEventListener('click', clearSource);
  els.collapseSourceButton.addEventListener('click', () => {
    setSourceCollapsed(true);
  });
  els.expandSourceButton.addEventListener('click', () => {
    setSourceCollapsed(false);
  });
  els.addCellButton.addEventListener('click', () => {
    setFillMode(fillMode === 'add' ? null : 'add');
  });
  els.deleteCellButton.addEventListener('click', () => {
    setFillMode(fillMode === 'delete' ? null : 'delete');
  });
  els.clearFillsButton.addEventListener('click', clearFills);
  els.copyButton.addEventListener('click', copyResult);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && fillMode) {
      event.preventDefault();
      const focusTarget =
        fillMode === 'delete' ? els.deleteCellButton : els.addCellButton;
      setFillMode(null, { silent: true });
      focusTarget.focus();
    }
  });

  window.addEventListener('resize', () => {
    applyScroll(els.fillScroll.scrollTop, els.fillScroll.scrollLeft);
  });

  render({ resetScroll: true });
})();
