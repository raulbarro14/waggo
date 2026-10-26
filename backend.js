/**
 * Conexión con Firebase (Auth con Google + Firestore con caché sin conexión).
 * Expone a app.js un objeto pequeño con lo que necesita, vía window.resolveBackend().
 */
import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signInWithRedirect, signOut
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, getDoc, onSnapshot, setDoc, deleteDoc
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const configured = !!(firebaseConfig && firebaseConfig.projectId && !firebaseConfig.apiKey.startsWith('PEGA'));

if (!configured) {
  window.resolveBackend({ configured: false });
} else {
  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  // Caché persistente: los datos se ven y se editan sin conexión y se sincronizan al volver
  const db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
  });

  window.resolveBackend({
    configured: true,

    onAuth(cb) {
      return onAuthStateChanged(auth, u => cb(u ? { email: u.email || '' } : null));
    },

    async signIn() {
      const provider = new GoogleAuthProvider();
      try {
        await signInWithPopup(auth, provider);
      } catch (e) {
        // Algunas apps instaladas no permiten ventanas emergentes
        if (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment') {
          await signInWithRedirect(auth, provider);
        } else {
          throw e;
        }
      }
    },

    signOut: () => signOut(auth),

    async getMembers() {
      const snap = await getDoc(doc(db, 'access', 'members'));
      return snap.exists() ? snap.data() : null;
    },

    subscribe(coll, next, error) {
      return onSnapshot(collection(db, coll), { includeMetadataChanges: true },
        snap => next(snap.docs.map(d => ({ ...d.data(), id: d.id })), snap.metadata.fromCache),
        error);
    },

    subscribeDoc(coll, id, next, error) {
      return onSnapshot(doc(db, coll, id), { includeMetadataChanges: true },
        snap => next(snap.exists() ? snap.data() : null, snap.metadata.fromCache),
        error);
    },

    set: (coll, id, body) => setDoc(doc(db, coll, id), body),
    remove: (coll, id) => deleteDoc(doc(db, coll, id))
  });
}
