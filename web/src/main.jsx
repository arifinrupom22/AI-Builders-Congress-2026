import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.jsx';
import './styles/index.css';

const container = document.getElementById('root');

function showFatal(message) {
  if (!container) return;
  container.innerHTML = `
    <div class="crash">
      <div class="crash__panel">
        <h1>LearnSphere AI did not start</h1>
        <p>${String(message ?? 'Unknown error').slice(0, 600)}</p>
        <p class="muted-xs">Check the browser console and the server log.</p>
      </div>
    </div>`;
}

if (!container) {
  console.error('LearnSphere AI: #root is missing from index.html');
} else {
  try {
    createRoot(container).render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  } catch (error) {
    console.error('LearnSphere AI failed to mount', error);
    showFatal(error?.message ?? error);
    throw error;
  }
}
