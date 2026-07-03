import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './styles.css';

const desktopMode =
  /Electron/i.test(window.navigator.userAgent) ||
  new URLSearchParams(window.location.search).get('desktop') === '1';

if (desktopMode) {
  document.documentElement.dataset.shell = 'electron';
  document.body.dataset.shell = 'electron';
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
