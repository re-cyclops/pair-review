// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/** Explicit clipboard export. Publication uses ReviewModal's exact manifest. */
class PreviewModal {
  get isVisible() { return Boolean(this.modal?.open); }

  async show() {
    if (!this.modal) {
      const node = ReviewModal.node;
      this.modal = window.reviewWorkspace.makeDialog('preview-modal', 'Export selected comments');
      this.modal.append(node('p', 'This Markdown export adds file and line headings. It is not the literal host payload. Use final preview before publishing.'));
      this.text = node('pre', '', { id: 'preview-text', class: 'workspace-export-text' });
      this.status = node('p', '', { role: 'status' });
      this.copy = node('button', 'Copy Markdown with locations', { type: 'button' });
      this.copy.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(this.text.textContent); this.status.textContent = 'Selected comments copied.'; }
        catch (error) { this.status.textContent = `Clipboard unavailable: ${error.message}`; }
      });
      const preview = node('button', 'Open exact final preview', { type: 'button' });
      preview.addEventListener('click', () => window.prManager.openReviewModal());
      const actions = node('div', null, { class: 'workspace-review-actions' });
      actions.append(this.copy, preview);
      this.modal.append(this.text, this.status, actions);
    }
    window.reviewWorkspace.open(this.modal);
    this.copy.disabled = true;
    this.text.textContent = '';
    this.status.textContent = 'Loading selected saved comments…';
    try {
      const reviewId = window.prManager.currentPR.id;
      await window.reviewDrafts.flushAll(reviewId);
      const response = await fetch(`/api/reviews/${reviewId}/manifest?local=true`);
      if (!response.ok) throw new Error(`Saved selection unavailable (${response.status})`);
      const manifest = await response.json();
      this.text.textContent = PreviewModal.formatManifest(manifest);
      this.copy.disabled = manifest.count === 0;
      this.status.textContent = `${manifest.count} selected saved comments. Excluded drafts remain local.`;
    } catch (error) { this.status.textContent = error.message; }
  }

  static formatManifest(manifest) {
    return PreviewModal.formatComments(manifest.comments.map(({ wire }) => ({
      file: wire.path, body: wire.body, is_file_level: Number(wire.isFileLevel),
      line_start: wire.start_line || wire.line, line_end: wire.line
    })));
  }

  static formatComments(comments) {
    if (!comments?.length) return 'No selected comments to export.';
    const groups = new Map();
    for (const comment of comments) {
      if (!groups.has(comment.file)) groups.set(comment.file, { fileComments: [], lineComments: [] });
      const group = groups.get(comment.file);
      (comment.is_file_level === 1 ? group.fileComments : group.lineComments).push(comment);
    }
    let text = '';
    for (const file of [...groups.keys()].sort()) {
      const { fileComments, lineComments } = groups.get(file);
      if (text) text += '\n';
      text += `## ${file}\n`;
      fileComments.forEach((comment, index) => { text += `\n### File Comment ${index + 1}:\n${comment.body}\n`; });
      lineComments.sort((left, right) => (left.line_start || 0) - (right.line_start || 0));
      for (const comment of lineComments) {
        const location = comment.line_end && comment.line_end !== comment.line_start
          ? `lines ${comment.line_start}-${comment.line_end}` : `line ${comment.line_start}`;
        text += `\n### Line Comment (${location}):\n${comment.body}\n`;
      }
    }
    return text;
  }
}

if (typeof window !== 'undefined') {
  window.PreviewModal = PreviewModal;
  window.previewModal = new PreviewModal();
}
if (typeof module !== 'undefined' && module.exports) module.exports = { PreviewModal };
