const fs = require('fs');
const assert = require('assert/strict');
const text = fs.readFileSync(__dirname + '/../js/muse_character_sheet_h3.js', 'utf8');
const start = text.indexOf('  _resizeOnce() {');
const end = text.indexOf('\n  // Debounced entry', start);
const editor = eval('({' + text.slice(start, end) + '})');
let size = [1480, 9000];
editor.node = {get size(){return size},setSize(v){size=v},setDirtyCanvas(){}};
editor.timelineWidget = {y:100,margin:10};
editor.container = {style:{},isConnected:true,
 get offsetHeight(){return this.style.width === '1460px' ? 1800 : 9000},
 get scrollHeight(){return this.offsetHeight}};
editor._resizeOnce();
assert.deepEqual(size,[1480,1916]);
assert.equal(editor.container.style.minWidth,'1460px');
editor._resizeOnce();
assert.deepEqual(size,[1480,1916]);
editor.container.isConnected=false;
editor._resizeOnce();
assert.equal(editor._cachedContentHeight,1800);
const configure=text.slice(text.indexOf('nodeType.prototype.onConfigure ='));
assert.match(configure,/editor\.build\(\);\s*}\s*\/\/[^\n]*\n\s*editor\._resizeOnce\(\);\s*editor\._scheduleNodeResize\(\)/);
console.log('PASS: width-before-height, shrinking stale height, repeat stability, detached DOM and unchanged-timeline restore');
