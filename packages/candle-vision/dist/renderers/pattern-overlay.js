const DEFAULT_THEME = {
    bullish: '#22c55e',
    bearish: '#ef4444',
    neutral: '#facc15',
    compression: '#38bdf8',
    setup: '#a78bfa',
    ta: '#fb923c',
    text: '#f8fafc',
};
export function resolvePatternOverlayOptions(options = {}) {
    return {
        theme: { ...DEFAULT_THEME, ...options.theme },
        showLabels: options.showLabels ?? true,
        showConfidence: options.showConfidence ?? true,
        showBoxTags: options.showBoxTags ?? true,
        showPins: options.showPins ?? true,
        showClusters: options.showClusters ?? true,
        maxLabels: options.maxLabels ?? 6,
        maxEvents: options.maxEvents ?? 12,
        maxActiveBoxes: options.maxActiveBoxes ?? 5,
        maxPins: options.maxPins ?? 28,
        maxBoxOverlapRatio: options.maxBoxOverlapRatio ?? 0.18,
        boxCollisionPaddingPx: options.boxCollisionPaddingPx ?? 8,
        minDisplayConfidence: options.minDisplayConfidence ?? 0.78,
        fillOpacity: options.fillOpacity ?? 0.018,
        strokeOpacity: options.strokeOpacity ?? 0.34,
        scanlineOpacity: options.scanlineOpacity ?? 0.5,
        labelCollisionPadding: options.labelCollisionPadding ?? 5,
        activeTtlMs: options.activeTtlMs ?? 2600,
        collapsedTtlMs: options.collapsedTtlMs ?? 14000,
        eventFadeOutMs: options.eventFadeOutMs ?? 900,
        clusterRadiusPx: options.clusterRadiusPx ?? 34,
        labelRightInsetPx: options.labelRightInsetPx ?? 0,
    };
}
export function renderPatternOverlay(ctx, renderContext, options = {}) {
    const resolvedOptions = resolvePatternOverlayOptions(options);
    if (!renderContext.events.length)
        return;
    const now = renderContext.now ?? getNow();
    const visibleEvents = renderContext.events.filter((event) => event.confidence >= resolvedOptions.minDisplayConfidence);
    const drawableEvents = collectDrawableEvents(renderContext, resolvedOptions, visibleEvents, now);
    const labelBoxes = [];
    ctx.save();
    ctx.textBaseline = 'middle';
    ctx.font = '11px Arial, Helvetica, sans-serif';
    const { boxed: active, collapsed: suppressedActive } = selectActiveBoxes(drawableEvents.filter((item) => item.state.phase === 'active'), resolvedOptions, renderContext.spotlightEventId);
    for (const item of active) {
        drawDetectionBox(ctx, resolvedOptions, renderContext, item.event, item.color, item.state.boxAlpha, item.spec, item.left, item.top, item.right, item.bottom, item.isVision, labelBoxes, now);
        if (resolvedOptions.showLabels && item.state.labelAlpha > 0 && item.event.confidence >= Math.max(0.78, resolvedOptions.minDisplayConfidence)) {
            drawLabel(ctx, resolvedOptions, renderContext, item.event, item.color, item.state.labelAlpha, labelBoxes, item.isVision);
        }
    }
    if (resolvedOptions.showPins) {
        const collapsed = drawableEvents
            .filter((item) => item.state.phase === 'collapsed')
            .concat(suppressedActive)
            .sort((a, b) => a.event.endIndex - b.event.endIndex)
            .slice(-resolvedOptions.maxPins);
        drawCollapsedMarkers(ctx, resolvedOptions, collapsed, now);
    }
    ctx.restore();
}
function selectActiveBoxes(items, options, spotlightEventId) {
    const maxBoxes = Math.max(0, Math.min(options.maxEvents, options.maxActiveBoxes));
    const boxed = [];
    const collapsed = [];
    const candidates = items
        .slice()
        .sort((a, b) => activeBoxPriority(b, spotlightEventId) - activeBoxPriority(a, spotlightEventId));
    for (const item of candidates) {
        const forced = Boolean(spotlightEventId && item.event.id === spotlightEventId);
        const overlaps = boxed.some((existing) => boxesOverlapTooMuch(existing, item, options));
        if (forced || (boxed.length < maxBoxes && !overlaps)) {
            boxed.push(item);
        }
        else {
            collapsed.push(collapseActiveEvent(item));
        }
    }
    return {
        boxed: boxed.sort((a, b) => a.event.endIndex - b.event.endIndex),
        collapsed,
    };
}
function activeBoxPriority(item, spotlightEventId) {
    const spotlightBoost = spotlightEventId && item.event.id === spotlightEventId ? 1000 : 0;
    const liveEndpointBoost = item.event.scoreBreakdown?.liveEndpoint ? 1.2 : 0;
    const liveProjectionBoost = item.event.scoreBreakdown?.liveProjection ? 0.42 : 0;
    const familyBoost = item.event.family === 'vision-candle' ? 0.08 : item.event.family === 'chart-setup' ? 0.05 : 0;
    const recencyBoost = item.event.endIndex / 100000;
    const ageSeconds = item.state.ageMs / 1000;
    const stabilityBoost = item.state.ageMs > 450 ? Math.min(0.18, ageSeconds * 0.035) : 0;
    const newbornPenalty = item.state.ageMs < 650 ? 0.12 : 0;
    const activeBoost = item.state.boxAlpha * 0.03;
    return spotlightBoost + liveEndpointBoost + liveProjectionBoost + item.event.confidence + familyBoost + recencyBoost + activeBoost + stabilityBoost - newbornPenalty;
}
function collapseActiveEvent(item) {
    return {
        ...item,
        state: {
            ...item.state,
            phase: 'collapsed',
            boxAlpha: 0,
            labelAlpha: 0,
            pinAlpha: Math.max(0.72, item.state.boxAlpha * 0.9, item.state.pinAlpha),
        },
    };
}
function boxesOverlapTooMuch(a, b, options) {
    const padding = Math.max(0, options.boxCollisionPaddingPx);
    const ax1 = a.left - padding;
    const ay1 = a.top - padding;
    const ax2 = a.right + padding;
    const ay2 = a.bottom + padding;
    const bx1 = b.left - padding;
    const by1 = b.top - padding;
    const bx2 = b.right + padding;
    const by2 = b.bottom + padding;
    const overlapWidth = Math.max(0, Math.min(ax2, bx2) - Math.max(ax1, bx1));
    const overlapHeight = Math.max(0, Math.min(ay2, by2) - Math.max(ay1, by1));
    const intersection = overlapWidth * overlapHeight;
    if (intersection <= 0)
        return false;
    const areaA = Math.max(1, (ax2 - ax1) * (ay2 - ay1));
    const areaB = Math.max(1, (bx2 - bx1) * (by2 - by1));
    return intersection / Math.min(areaA, areaB) > options.maxBoxOverlapRatio;
}
function collectDrawableEvents(renderContext, options, events, now) {
    const items = [];
    for (const event of events) {
        const state = resolveEventVisualState(event, now, renderContext.firstSeen, options, event.id === renderContext.spotlightEventId);
        if (!state)
            continue;
        const start = renderContext.candles[event.startIndex];
        const end = renderContext.candles[event.endIndex];
        if (!start || !end)
            continue;
        const xStart = renderContext.logicalToCoordinate(event.startIndex);
        const xEnd = renderContext.logicalToCoordinate(event.endIndex);
        const span = renderContext.candles.slice(event.startIndex, event.endIndex + 1);
        if (!span.length)
            continue;
        const yHigh = renderContext.priceToCoordinate(Math.max(...span.map((bar) => bar.high)));
        const yLow = renderContext.priceToCoordinate(Math.min(...span.map((bar) => bar.low)));
        if (xStart == null || xEnd == null || yHigh == null || yLow == null)
            continue;
        const left = Math.min(xStart, xEnd) - 5;
        const right = Math.max(xStart, xEnd) + 5;
        const top = Math.min(yHigh, yLow) - 7;
        const bottom = Math.max(yHigh, yLow) + 7;
        const { width, height } = renderContext.mediaSize;
        if (right < -30 || left > width + 30 || bottom < -30 || top > height + 30)
            continue;
        const anchorCandle = renderContext.candles[event.endIndex];
        const anchorX = renderContext.logicalToCoordinate(event.endIndex);
        const anchorPrice = event.direction === 'bearish' ? anchorCandle.high : anchorCandle.low;
        const anchorY = renderContext.priceToCoordinate(anchorPrice);
        if (anchorX == null || anchorY == null)
            continue;
        items.push({
            event,
            state,
            color: eventColor(event, options.theme),
            isVision: isComputerVisionEvent(event),
            spec: animationSpecForPattern(event),
            left,
            right,
            top,
            bottom,
            anchorX,
            anchorY,
        });
    }
    return items;
}
function introProgress(event, now, firstSeen) {
    const seenAt = firstSeen?.get(event.id) ?? now;
    const elapsed = now - seenAt;
    const spec = animationSpecForPattern(event);
    return Math.max(0, Math.min(1, elapsed / (spec.duration * 1000)));
}
function resolveEventVisualState(event, now, firstSeen, options, spotlighted) {
    if (spotlighted) {
        return { phase: 'active', boxAlpha: 1, labelAlpha: 1, pinAlpha: 0, ageMs: 0 };
    }
    const seenAt = firstSeen?.get(event.id) ?? now;
    const elapsed = Math.max(0, now - seenAt);
    const intro = easeOutCubic(introProgress(event, now, firstSeen));
    const activeTtl = Math.max(1, options.activeTtlMs);
    if (elapsed <= activeTtl) {
        const labelFade = Math.max(0.24, 1 - Math.max(0, elapsed - activeTtl * 0.76) / Math.max(1, activeTtl * 0.24));
        return {
            phase: 'active',
            boxAlpha: intro,
            labelAlpha: intro * labelFade,
            pinAlpha: 0,
            ageMs: elapsed,
        };
    }
    if (!Number.isFinite(options.collapsedTtlMs)) {
        return { phase: 'collapsed', boxAlpha: 0, labelAlpha: 0, pinAlpha: 0.84, ageMs: elapsed };
    }
    const collapsedElapsed = elapsed - activeTtl;
    if (collapsedElapsed <= options.collapsedTtlMs) {
        const collapseIntro = Math.min(1, collapsedElapsed / Math.max(1, options.eventFadeOutMs));
        return { phase: 'collapsed', boxAlpha: 0, labelAlpha: 0, pinAlpha: 0.56 + collapseIntro * 0.28, ageMs: elapsed };
    }
    const fadeMs = Math.max(1, options.eventFadeOutMs);
    const fadeProgress = (collapsedElapsed - options.collapsedTtlMs) / fadeMs;
    const pinAlpha = Math.max(0, 0.84 * (1 - fadeProgress));
    if (pinAlpha <= 0)
        return null;
    return { phase: 'collapsed', boxAlpha: 0, labelAlpha: 0, pinAlpha, ageMs: elapsed };
}
function eventColor(event, theme) {
    if (event.kind === 'vision-compression')
        return theme.compression;
    if (event.family === 'chart-setup')
        return theme.setup;
    if (event.kind.startsWith('ma-') ||
        event.kind.startsWith('rsi-') ||
        event.kind.startsWith('macd-') ||
        event.kind.startsWith('bollinger-') ||
        event.kind.startsWith('volume-') ||
        event.kind.startsWith('atr-') ||
        event.kind.startsWith('vwap-')) {
        return theme.ta;
    }
    if (event.direction === 'bullish')
        return theme.bullish;
    if (event.direction === 'bearish')
        return theme.bearish;
    return theme.neutral;
}
function isComputerVisionEvent(event) {
    return event.family === 'vision-candle' || event.family === 'chart-setup' || event.kind.startsWith('vision-');
}
function animationSpecForPattern(event) {
    if (event.status === 'forming')
        return { duration: 0.9, strokeDash: [4, 7] };
    if (event.kind === 'vision-compression' || event.kind.includes('squeeze'))
        return { duration: 0.42, strokeDash: [5, 6] };
    if (event.kind.includes('breakout') || event.kind.includes('breakdown') || event.kind.includes('reclaim'))
        return { duration: 0.36 };
    if (event.kind.startsWith('ma-') ||
        event.kind.startsWith('rsi-') ||
        event.kind.startsWith('macd-') ||
        event.kind.startsWith('bollinger-') ||
        event.kind.startsWith('atr-') ||
        event.kind.startsWith('vwap-') ||
        event.kind.startsWith('volume-')) {
        return { duration: 0.22 };
    }
    if (event.family === 'chart-setup')
        return { duration: 0.5, strokeDash: [8, 5] };
    if (event.status === 'confirmed')
        return { duration: 0.32 };
    return { duration: 0.18 };
}
function drawDetectionBox(ctx, options, renderContext, event, color, progress, spec, left, top, right, bottom, isVision, labelBoxes, now) {
    const width = Math.max(1, right - left);
    const height = Math.max(1, bottom - top);
    const setupFillScale = event.family === 'chart-setup' ? 0.58 : 1;
    const setupStrokeScale = event.family === 'chart-setup' ? 0.72 : 1;
    ctx.save();
    ctx.globalAlpha = (isVision ? options.fillOpacity * 2.6 * setupFillScale : options.fillOpacity) * progress;
    ctx.fillStyle = color;
    drawRoundedRect(ctx, left, top, width, height, isVision ? 2 : 4);
    ctx.fill();
    ctx.restore();
    if (isVision) {
        drawVisionGrid(ctx, options, color, progress, left, top, right, bottom, now);
        drawCornerBrackets(ctx, color, progress, left, top, right, bottom);
        drawConfidenceRail(ctx, event, color, progress, right, top, bottom);
        drawAnchorPings(ctx, renderContext, event, color, progress, now);
    }
    ctx.save();
    ctx.globalAlpha = (isVision ? Math.min(0.96, options.strokeOpacity * 1.45 * setupStrokeScale) : options.strokeOpacity) * progress;
    ctx.strokeStyle = color;
    ctx.lineWidth = isVision ? event.family === 'chart-setup' ? 1.25 : 1.65 : event.status === 'confirmed' ? 1.15 : 0.95;
    if (event.status === 'forming' || spec.strokeDash || isVision)
        ctx.setLineDash(isVision ? [7, 5] : spec.strokeDash ?? [5, 6]);
    drawRoundedRect(ctx, left + 0.5, top + 0.5, width, height, isVision ? 2 : 4);
    ctx.stroke();
    ctx.restore();
    if (options.showBoxTags) {
        drawBoxTag(ctx, options, renderContext, event, color, progress, left, top, right, bottom, isVision, labelBoxes);
    }
}
function drawBoxTag(ctx, options, renderContext, event, color, progress, left, top, right, bottom, isVision, labelBoxes) {
    const boxWidth = Math.max(1, right - left);
    const boxHeight = Math.max(1, bottom - top);
    if (boxWidth < 18 || boxHeight < 16)
        return;
    const confidence = `${Math.round(event.confidence * 100)}%`;
    const name = eventDisplayName(event);
    const compact = boxWidth < 64 || boxHeight < 28;
    const medium = boxWidth < 130;
    const compactLabel = shortPatternName(name);
    const mediumLabel = `${shortPatternName(name)} · ${confidence}`;
    const fullLabel = `${name} · ${confidence}`;
    const variants = compact
        ? [{ label: compactLabel, font: '700 9px Arial, Helvetica, sans-serif', paddingX: 6, height: 17, minWidth: 40 }]
        : medium
            ? [
                { label: mediumLabel, font: '700 10px Arial, Helvetica, sans-serif', paddingX: 8, height: 20, minWidth: 62 },
                { label: compactLabel, font: '700 9px Arial, Helvetica, sans-serif', paddingX: 6, height: 17, minWidth: 40 },
            ]
            : [
                { label: fullLabel, font: '700 10px Arial, Helvetica, sans-serif', paddingX: 8, height: 20, minWidth: 62 },
                { label: mediumLabel, font: '700 10px Arial, Helvetica, sans-serif', paddingX: 8, height: 20, minWidth: 62 },
                { label: compactLabel, font: '700 9px Arial, Helvetica, sans-serif', paddingX: 6, height: 17, minWidth: 40 },
            ];
    const collisionPadding = Math.min(12, Math.max(2, options.labelCollisionPadding * 0.35));
    let selected = null;
    for (const variant of variants) {
        ctx.save();
        ctx.font = variant.font;
        const tagHeight = variant.height;
        const tagWidth = Math.min(Math.max(ctx.measureText(variant.label).width + variant.paddingX * 2 + 5, variant.minWidth), Math.min(280, renderContext.mediaSize.width - 16));
        ctx.restore();
        const candidates = tagPlacementCandidates(renderContext, options, tagWidth, tagHeight, left, top, right, bottom);
        const candidate = candidates.find((next) => {
            const box = { x: next.x, y: next.y, width: tagWidth, height: tagHeight };
            return !labelBoxes.some((other) => intersects(box, other, collisionPadding));
        });
        if (candidate) {
            selected = { ...variant, tagWidth, tagHeight, x: candidate.x, y: candidate.y };
            break;
        }
    }
    if (!selected)
        return;
    const { label, paddingX, tagHeight, tagWidth, x, y } = selected;
    labelBoxes.push({ x, y, width: tagWidth, height: tagHeight });
    ctx.save();
    ctx.globalAlpha = Math.min(1, progress * (isVision || event.family === 'chart-setup' ? 0.92 : 0.72));
    ctx.fillStyle = 'rgba(4, 13, 26, .86)';
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    drawRoundedRect(ctx, x, y, tagWidth, tagHeight, 4);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.fillRect(x + 6, y + 5, 3, tagHeight - 10);
    ctx.fillStyle = '#f8fafc';
    ctx.font = selected.font;
    ctx.textAlign = 'left';
    ctx.fillText(label, x + paddingX + 5, y + tagHeight / 2 + 0.5);
    ctx.restore();
}
function tagPlacementCandidates(renderContext, options, tagWidth, tagHeight, left, top, right, bottom) {
    const maxX = Math.max(8, renderContext.mediaSize.width - tagWidth - 8 - options.labelRightInsetPx);
    const maxY = Math.max(8, renderContext.mediaSize.height - tagHeight - 8);
    const clampX = (value) => Math.max(8, Math.min(maxX, value));
    const clampY = (value) => Math.max(8, Math.min(maxY, value));
    return [
        { x: clampX(left + 6), y: clampY(top + 6) },
        { x: clampX(left + 6), y: clampY(bottom - tagHeight - 6) },
        { x: clampX(right - tagWidth - 6), y: clampY(top + 6) },
        { x: clampX(right - tagWidth - 6), y: clampY(bottom - tagHeight - 6) },
    ];
}
function drawCollapsedMarkers(ctx, options, items, now) {
    if (!items.length)
        return;
    const clusters = options.showClusters ? clusterMarkers(items, options.clusterRadiusPx) : items.map((item) => ({
        x: item.anchorX,
        y: markerY(item),
        events: [item],
        color: item.color,
        direction: item.event.direction,
    }));
    for (const cluster of clusters) {
        if (cluster.events.length > 1) {
            drawClusterBadge(ctx, cluster, now);
        }
        else {
            drawPin(ctx, cluster.events[0], now);
        }
    }
}
function clusterMarkers(items, radius) {
    const clusters = [];
    for (const item of items) {
        const x = item.anchorX;
        const y = markerY(item);
        const existing = clusters.find((cluster) => Math.hypot(cluster.x - x, cluster.y - y) <= radius);
        if (existing) {
            existing.events.push(item);
            existing.x = existing.events.reduce((sum, next) => sum + next.anchorX, 0) / existing.events.length;
            existing.y = existing.events.reduce((sum, next) => sum + markerY(next), 0) / existing.events.length;
            existing.color = dominantClusterColor(existing.events);
            existing.direction = dominantClusterDirection(existing.events);
        }
        else {
            clusters.push({ x, y, events: [item], color: item.color, direction: item.event.direction });
        }
    }
    return clusters;
}
function markerY(item) {
    const offset = item.event.direction === 'bearish' ? -12 : 12;
    return item.anchorY + offset;
}
function dominantClusterColor(items) {
    const sorted = items.slice().sort((a, b) => b.event.confidence - a.event.confidence);
    return sorted[0]?.color ?? '#94a3b8';
}
function dominantClusterDirection(items) {
    const bullish = items.filter((item) => item.event.direction === 'bullish').length;
    const bearish = items.filter((item) => item.event.direction === 'bearish').length;
    if (bullish > bearish)
        return 'bullish';
    if (bearish > bullish)
        return 'bearish';
    return 'neutral';
}
function drawPin(ctx, item, now) {
    const x = item.anchorX;
    const y = markerY(item);
    const pulse = 0.5 + Math.sin(now / 190 + item.event.endIndex) * 0.5;
    ctx.save();
    ctx.globalAlpha = item.state.pinAlpha;
    ctx.fillStyle = 'rgba(15, 23, 42, .9)';
    ctx.strokeStyle = item.color;
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.arc(x, y, 4.6 + pulse * 1.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.globalAlpha = Math.min(1, item.state.pinAlpha + 0.1);
    ctx.fillStyle = item.color;
    ctx.beginPath();
    ctx.arc(x, y, 1.7, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
}
function drawClusterBadge(ctx, cluster, now) {
    const strongest = cluster.events.reduce((best, item) => item.event.confidence > best.event.confidence ? item : best, cluster.events[0]);
    const alpha = Math.max(...cluster.events.map((item) => item.state.pinAlpha));
    const pulse = 0.5 + Math.sin(now / 220 + cluster.events.length) * 0.5;
    const label = `+${cluster.events.length}`;
    const width = Math.max(27, ctx.measureText(label).width + 15);
    const height = 20;
    const x = cluster.x - width / 2;
    const y = cluster.y - height / 2;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = 'rgba(15, 23, 42, .92)';
    ctx.strokeStyle = strongest.color;
    ctx.lineWidth = 1.2 + pulse * 0.35;
    drawRoundedRect(ctx, x, y, width, height, 999);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = strongest.color;
    ctx.font = '700 11px Arial, Helvetica, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(label, cluster.x, cluster.y + 0.5);
    ctx.restore();
}
function drawVisionGrid(ctx, options, color, progress, left, top, right, bottom, now) {
    const width = right - left;
    const height = bottom - top;
    const sweep = top + ((now / 9) % Math.max(12, height + 24)) - 12;
    ctx.save();
    ctx.beginPath();
    drawRoundedRect(ctx, left, top, width, height, 2);
    ctx.clip();
    ctx.globalAlpha = 0.18 * progress;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash([1, 7]);
    for (let x = left + 8; x < right; x += 12) {
        ctx.beginPath();
        ctx.moveTo(x, top);
        ctx.lineTo(x, bottom);
        ctx.stroke();
    }
    for (let y = top + 8; y < bottom; y += 12) {
        ctx.beginPath();
        ctx.moveTo(left, y);
        ctx.lineTo(right, y);
        ctx.stroke();
    }
    ctx.globalAlpha = options.scanlineOpacity * progress;
    ctx.setLineDash([]);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(left, sweep);
    ctx.lineTo(right, sweep);
    ctx.stroke();
    const gradient = ctx.createLinearGradient(0, sweep - 10, 0, sweep + 10);
    gradient.addColorStop(0, 'rgba(255,255,255,0)');
    gradient.addColorStop(0.5, color);
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.globalAlpha = 0.1 * progress;
    ctx.fillStyle = gradient;
    ctx.fillRect(left, sweep - 12, width, 24);
    ctx.restore();
}
function drawCornerBrackets(ctx, color, progress, left, top, right, bottom) {
    const length = Math.min(18, Math.max(8, (right - left) * 0.22));
    ctx.save();
    ctx.globalAlpha = 0.92 * progress;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    drawCorner(ctx, left, top, length, 1, 1);
    drawCorner(ctx, right, top, length, -1, 1);
    drawCorner(ctx, left, bottom, length, 1, -1);
    drawCorner(ctx, right, bottom, length, -1, -1);
    ctx.restore();
}
function drawConfidenceRail(ctx, event, color, progress, right, top, bottom) {
    const height = bottom - top;
    const railHeight = Math.max(3, height * event.confidence);
    ctx.save();
    ctx.globalAlpha = 0.82 * progress;
    ctx.fillStyle = 'rgba(15, 23, 42, .78)';
    ctx.fillRect(right + 3, top, 3, height);
    ctx.fillStyle = color;
    ctx.fillRect(right + 3, bottom - railHeight, 3, railHeight);
    ctx.restore();
}
function drawAnchorPings(ctx, renderContext, event, color, progress, now) {
    const pulse = 0.5 + Math.sin(now / 170) * 0.5;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    for (const anchor of event.anchors.slice(-3)) {
        const x = renderContext.logicalToCoordinate(anchor.index);
        const y = renderContext.priceToCoordinate(anchor.price);
        if (x == null || y == null)
            continue;
        ctx.globalAlpha = (0.26 + pulse * 0.2) * progress;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(x, y, 5 + pulse * 4, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 0.86 * progress;
        ctx.beginPath();
        ctx.arc(x, y, 2.2, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.restore();
}
function drawLabel(ctx, options, renderContext, event, color, progress, boxes, isVision) {
    if (boxes.length >= options.maxLabels)
        return;
    const candle = renderContext.candles[event.endIndex];
    if (!candle)
        return;
    const x = renderContext.logicalToCoordinate(event.endIndex);
    const y = renderContext.priceToCoordinate(event.direction === 'bearish' ? candle.high : candle.low);
    if (x == null || y == null)
        return;
    const name = eventDisplayName(event);
    const score = `${(event.confidence * 100).toFixed(0)}%`;
    const label = options.showConfidence ? `${name} ${score}` : name;
    const width = Math.min(260, Math.max(84, ctx.measureText(label).width + 22));
    const height = isVision ? 24 : 21;
    const rightBound = Math.max(8, renderContext.mediaSize.width - width - 8 - options.labelRightInsetPx);
    const labelX = Math.min(rightBound, Math.max(8, x - width / 2));
    const preferredY = event.direction === 'bearish' ? y - 25 : y + 25;
    const labelY = findFreeLabelY(preferredY, width, height, labelX, boxes, renderContext.mediaSize.height, options.labelCollisionPadding);
    if (labelY == null)
        return;
    boxes.push({ x: labelX, y: labelY - height / 2, width, height });
    ctx.save();
    ctx.globalAlpha = progress;
    ctx.translate(0, (1 - progress) * 4);
    ctx.fillStyle = isVision ? 'rgba(4, 13, 26, .94)' : 'rgba(15, 23, 42, .9)';
    ctx.strokeStyle = color;
    ctx.lineWidth = isVision ? 1.35 : 1;
    drawRoundedRect(ctx, labelX, labelY - height / 2, width, height, 5);
    ctx.fill();
    ctx.stroke();
    if (isVision) {
        ctx.globalAlpha = 0.34 * progress;
        ctx.fillStyle = color;
        ctx.fillRect(labelX + 7, labelY - height / 2 + 5, 3, height - 10);
    }
    // Label pill always uses a dark background (above), so text must stay light
    // regardless of the chart theme — theme.text is tuned for the light-theme DOM
    // UI and renders black-on-black here. Match drawBoxTag's hardcoded light text.
    ctx.fillStyle = '#f8fafc';
    ctx.globalAlpha = 0.96 * progress;
    ctx.textAlign = 'center';
    ctx.fillText(label, labelX + width / 2, labelY);
    ctx.restore();
}
function eventDisplayName(event) {
    const raw = event.label || event.kind;
    return humanizeSignalName(raw)
        .replace(/^(CANDLE|PATTERN|VISION|SETUP|TA|SCAN)\s*[·:_-]\s*/i, '')
        .replace(/^(CANDLE|PATTERN|VISION|SETUP|TA|SCAN)\s+/i, '')
        .trim() || humanizeSignalName(event.kind);
}
function shortPatternName(name) {
    const words = name.split(/\s+/).filter(Boolean);
    if (words.length <= 3)
        return name;
    return words.slice(0, 3).join(' ');
}
function humanizeSignalName(value) {
    return value
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\b\w/g, (char) => char.toUpperCase());
}
function isTaEvent(event) {
    return (event.kind.startsWith('ma-') ||
        event.kind.startsWith('rsi-') ||
        event.kind.startsWith('macd-') ||
        event.kind.startsWith('bollinger-') ||
        event.kind.startsWith('volume-') ||
        event.kind.startsWith('atr-') ||
        event.kind.startsWith('vwap-'));
}
function findFreeLabelY(preferredY, width, height, x, boxes, mediaHeight, padding) {
    const candidates = [preferredY, preferredY - 24, preferredY + 24, preferredY - 48, preferredY + 48];
    for (const y of candidates) {
        const box = { x, y: y - height / 2, width, height };
        if (box.y < 8 || box.y + height > mediaHeight - 8)
            continue;
        if (!boxes.some((other) => intersects(box, other, padding)))
            return y;
    }
    return null;
}
function intersects(a, b, padding) {
    return !(a.x + a.width + padding < b.x ||
        b.x + b.width + padding < a.x ||
        a.y + a.height + padding < b.y ||
        b.y + b.height + padding < a.y);
}
function drawCorner(ctx, x, y, length, xDirection, yDirection) {
    ctx.beginPath();
    ctx.moveTo(x, y + yDirection * length);
    ctx.lineTo(x, y);
    ctx.lineTo(x + xDirection * length, y);
    ctx.stroke();
}
function easeOutCubic(value) {
    return 1 - Math.pow(1 - value, 3);
}
function drawRoundedRect(ctx, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height - r);
    ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    ctx.lineTo(x + r, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}
function getNow() {
    return typeof performance === 'undefined' ? Date.now() : performance.now();
}
//# sourceMappingURL=pattern-overlay.js.map