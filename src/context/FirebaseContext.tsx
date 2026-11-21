import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import {
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type User,
} from 'firebase/auth';
import {
  auth,
  firebaseConfig,
  googleProvider,
  testFirestoreConnection,
} from '../firebase';
import { syncUserProfileToFirestore } from '../utils/firestoreSync';

interface FirebaseContextValue {
  user: User | null;
  authReady: boolean;
  firestoreConnected: boolean;
  firestoreOffline: boolean;
  firebaseError: string | null;
  projectId: string;
  databaseId: string;
  signingIn: boolean;
  signInWithGoogle: () => Promise<void>;
  signOutUser: () => Promise<void>;
  clearFirebaseError: () => void;
}

const FirebaseContext = createContext<FirebaseContextValue | null>(null);

export const FirebaseProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [firestoreConnected, setFirestoreConnected] = useState(false);
  const [firestoreOffline, setFirestoreOffline] = useState(false);
  const [firebaseError, setFirebaseError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);

  useEffect(() => {
    let active = true;
    testFirestoreConnection().then((res) => {
      if (!active) return;
      setFirestoreConnected(res.connected);
      setFirestoreOffline(res.offline);
      if (res.error) {
        setFirebaseError(res.error);
      }
    });

    const unsub = onAuthStateChanged(auth, async (nextUser) => {
      if (!active) return;
      setUser(nextUser);
      setAuthReady(true);
      if (nextUser && nextUser.emailVerified) {
        try {
          await syncUserProfileToFirestore(nextUser);
        } catch (err) {
          if (active) {
            setFirebaseError(
              err instanceof Error
                ? err.message
                : 'Failed to sync user profile to Firestore.'
            );
          }
        }
      }
    });

    return () => {
      active = false;
      unsub();
    };
  }, []);

  const signInWithGoogle = useCallback(async () => {
    setSigningIn(true);
    setFirebaseError(null);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'Google Sign-In failed.';
      if (!/popup-closed-by-user/i.test(msg)) {
        setFirebaseError(msg);
      }
    } finally {
      setSigningIn(false);
    }
  }, []);

  const signOutUser = useCallback(async () => {
    setFirebaseError(null);
    await signOut(auth);
  }, []);

  return (
    <FirebaseContext.Provider
      value={{
        user,
        authReady,
        firestoreConnected,
        firestoreOffline,
        firebaseError,
        projectId: firebaseConfig.projectId,
        databaseId: firebaseConfig.firestoreDatabaseId,
        signingIn,
        signInWithGoogle,
        signOutUser,
        clearFirebaseError: () => setFirebaseError(null),
      }}
    >
      {children}
    </FirebaseContext.Provider>
  );
};

export function useFirebase(): FirebaseContextValue {
  const ctx = useContext(FirebaseContext);
  if (!ctx) {
    throw new Error('useFirebase must be used inside a FirebaseProvider');
  }
  return ctx;
}
