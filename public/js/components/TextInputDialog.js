// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Generic Text Input Dialog Component
 * Displays a modal dialog with a text input field and customizable actions.
 * Returns a Promise that resolves to the trimmed input string, or null if cancelled.
 */
class TextInputDialog {
  constructor() {
    this.modal = null;
    this.isVisible = false;
    this.resolvePromise = null;
    this.createModal();
    this.setupEventListeners();
  }

  /**
   * Create the modal DOM structure
   */
  createModal() {
    // Remove existing modal if it exists
    const existing = document.getElementById('text-input-dialog');
    if (existing) {
      existing.remove();
    }

    // Create modal container
    const modalContainer = document.createElement('dialog');
    modalContainer.id = 'text-input-dialog';
    modalContainer.className = 'modal-overlay text-input-dialog-overlay';
    modalContainer.setAttribute('aria-labelledby', 'text-input-dialog-title');
    modalContainer.style.display = 'none';

    modalContainer.innerHTML = `
      <div class="modal-backdrop" data-action="cancel"></div>
      <form class="modal-container confirm-dialog-container text-input-dialog-container">
        <div class="modal-header">
          <h3 id="text-input-dialog-title">Input</h3>
          <button type="button" class="modal-close-btn" data-action="cancel" title="Close" aria-label="Close input dialog">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z"/>
            </svg>
          </button>
        </div>

        <div class="modal-body">
          <div class="text-input-dialog-field">
            <label for="text-input-dialog-input" id="text-input-dialog-label"></label>
            <input type="text" id="text-input-dialog-input" name="dialog-value" class="form-control" placeholder="" autocomplete="off" autofocus />
          </div>
        </div>

        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" data-action="cancel">Cancel</button>
          <button type="submit" class="btn btn-primary" id="text-input-dialog-btn">
            Save
          </button>
        </div>
      </form>
    `;

    document.body.appendChild(modalContainer);
    this.modal = modalContainer;
  }

  /**
   * Setup event listeners
   */
  setupEventListeners() {
    // Use event delegation for click events
    this.modal.addEventListener('click', (e) => {
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action === 'cancel') {
        e.preventDefault();
        this.handleCancel();
      }
    });

    // Native modal focus containment and button activation preserve Cancel's
    // keyboard behavior. Only form submission accepts the input.
    this.modal.querySelector('form').addEventListener('submit', (event) => {
      event.preventDefault();
      if (this.isVisible && !event.isComposing) this.handleConfirm();
    });
    this.modal.addEventListener('cancel', (event) => {
      event.preventDefault();
      this.handleCancel();
    });
    this.modal.addEventListener('close', () => {
      // Ignore an older queued close event if the dialog has already reopened.
      if (!this.modal.open && this.isVisible) this.hide();
    });

    // Listen for input changes to enable/disable confirm button
    const input = this.modal.querySelector('#text-input-dialog-input');
    if (input) {
      input.addEventListener('input', () => {
        this._updateConfirmButton(input.value);
      });
    }
  }

  /**
   * Update the confirm button enabled/disabled state based on input value
   * @param {string} value - Current input value
   */
  _updateConfirmButton(value) {
    const confirmBtn = this.modal.querySelector('#text-input-dialog-btn');
    if (confirmBtn) {
      confirmBtn.disabled = !value.trim();
    }
  }

  /**
   * Show the text input dialog
   * @param {Object} options - Configuration options
   * @param {string} options.title - Dialog title (default: "Input")
   * @param {string} options.label - Label text above the input (default: "")
   * @param {string} options.placeholder - Input placeholder text (default: "")
   * @param {string} options.value - Initial input value (default: "")
   * @param {string} options.confirmText - Confirm button text (default: "Save")
   * @param {string} options.confirmClass - Confirm button CSS class (default: "btn-primary")
   * @returns {Promise<string|null>} Promise that resolves to trimmed input string, or null if cancelled
   */
  show(options = {}) {
    if (!this.modal) return Promise.resolve(null);

    return new Promise((resolve) => {
      // Cancel any previous caller's promise to prevent dangling awaits
      if (this.resolvePromise) {
        this.resolvePromise(null);
      }
      this.resolvePromise = resolve;

      // Set title
      const titleElement = this.modal.querySelector('#text-input-dialog-title');
      if (titleElement) {
        titleElement.textContent = options.title || 'Input';
      }

      // Set label
      const labelElement = this.modal.querySelector('#text-input-dialog-label');
      if (labelElement) {
        const labelText = options.label || '';
        labelElement.textContent = labelText;
        labelElement.style.display = labelText ? '' : 'none';
      }

      // Set input value and placeholder
      const input = this.modal.querySelector('#text-input-dialog-input');
      if (input) {
        input.value = options.value || '';
        input.placeholder = options.placeholder || '';
        input.setAttribute('aria-label', options.label || options.title || 'Input');
      }

      // Set confirm button text and style
      const confirmBtn = this.modal.querySelector('#text-input-dialog-btn');
      if (confirmBtn) {
        confirmBtn.textContent = options.confirmText || 'Save';
        // Remove previous style classes and add new one
        confirmBtn.classList.remove('btn-primary', 'btn-secondary', 'btn-danger', 'btn-warning');
        const confirmClass = options.confirmClass || 'btn-primary';
        confirmBtn.classList.add(confirmClass);
      }

      // Update confirm button state based on initial value
      this._updateConfirmButton(options.value || '');

      // showModal promotes this dialog above an already-open analysis dialog.
      if (!this.modal.open) this.returnFocus = document.activeElement;
      this.modal.style.display = 'flex';
      this.isVisible = true;
      if (!this.modal.open) this.modal.showModal();
      if (input) {
        input.focus();
        input.select();
      }
    });
  }

  /**
   * Handle confirm action
   */
  handleConfirm() {
    if (!this.isVisible) return;
    const input = this.modal.querySelector('#text-input-dialog-input');
    const value = input ? input.value.trim() : '';
    if (!value) return;

    this.hide(value);
  }

  /**
   * Handle cancel action
   */
  handleCancel() {
    this.hide();
  }

  /**
   * Hide the modal
   */
  hide(value = null) {
    if (!this.modal) return;

    const resolve = this.resolvePromise;
    this.resolvePromise = null;
    this.isVisible = false;
    if (this.modal.open) this.modal.close();
    this.modal.style.display = 'none';
    if (this.returnFocus?.isConnected) this.returnFocus.focus({ preventScroll: true });
    this.returnFocus = null;
    // Direct hide()/close() calls must not leave a caller awaiting forever.
    if (resolve) resolve(value);
  }
}

// Initialize global instance
if (typeof window !== 'undefined' && !window.textInputDialog) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      window.textInputDialog = new TextInputDialog();
    });
  } else {
    window.textInputDialog = new TextInputDialog();
  }
}
