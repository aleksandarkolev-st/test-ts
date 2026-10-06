import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import Overlay from './overlay/Overlay';
import Debug from './Debug';
import './style.css';
const view = new URLSearchParams(location.search).get('view');
document.documentElement.dataset.view = view ?? 'main';
createRoot(document.getElementById('root')!).render(<React.StrictMode>{view === 'overlay' ? <Overlay /> : view === 'debug' ? <Debug /> : <App />}</React.StrictMode>);
