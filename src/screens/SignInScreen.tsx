import React, { useState } from "react";
import {
  View,
  Text,
  TextInput,
  Button,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
} from "react-native";
import { supabase } from "../lib/supabase";

type Mode = "signin" | "signup";

export default function SignInScreen() {
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      if (mode === "signup") {
        const { data, error: signUpError } = await supabase.auth.signUp({
          email: email.trim(),
          password,
        });
        if (signUpError) throw signUpError;

        // If email confirmation is enabled on the project, signUp succeeds but
        // returns no session — the user is stuck until they click the link.
        // App.tsx only flips to the app once a session exists, so say so.
        if (!data.session) {
          setNotice(
            "Account created. Check your email for a confirmation link, then sign in. " +
              "(To skip this for personal use, turn off 'Confirm email' in Supabase → " +
              "Authentication → Sign In / Providers → Email.)",
          );
          setMode("signin");
        }
        // If a session came back, App.tsx's auth listener takes over from here.
      } else {
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (signInError) throw signInError;
      }
    } catch (e: any) {
      setError(e.message ?? "Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  const canSubmit = email.trim().length > 0 && password.length >= 6 && !loading;

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={styles.inner}>
        <Text style={styles.heading}>Workrate</Text>
        <Text style={styles.subtext}>
          {mode === "signin"
            ? "Sign in to pick up where you left off."
            : "Create an account to start tracking what matters."}
        </Text>

        <TextInput
          style={styles.input}
          placeholder="you@example.com"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          textContentType="emailAddress"
          editable={!loading}
        />
        <TextInput
          style={styles.input}
          placeholder="Password (min 6 characters)"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoCapitalize="none"
          textContentType={mode === "signup" ? "newPassword" : "password"}
          editable={!loading}
        />

        <Button
          title={
            loading
              ? "Working..."
              : mode === "signin"
                ? "Sign in"
                : "Create account"
          }
          onPress={submit}
          disabled={!canSubmit}
        />
        {loading && <ActivityIndicator style={{ marginTop: 12 }} />}
        {error && <Text style={styles.error}>{error}</Text>}
        {notice && <Text style={styles.notice}>{notice}</Text>}

        <Pressable
          onPress={() => {
            setMode(mode === "signin" ? "signup" : "signin");
            setError(null);
            setNotice(null);
          }}
          disabled={loading}
        >
          <Text style={styles.switch}>
            {mode === "signin"
              ? "No account yet? Create one"
              : "Already have an account? Sign in"}
          </Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff", justifyContent: "center" },
  inner: { padding: 24, maxWidth: 420, width: "100%", alignSelf: "center" },
  heading: { fontSize: 30, fontWeight: "700" },
  subtext: { color: "#666", marginTop: 6, marginBottom: 24 },
  input: {
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
    fontSize: 15,
  },
  error: { color: "#c0392b", marginTop: 12 },
  notice: { color: "#2c6e49", marginTop: 12, lineHeight: 19 },
  switch: { color: "#3060d0", marginTop: 24, textAlign: "center" },
});
