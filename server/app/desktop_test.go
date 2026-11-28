//go:build !headless

package app

import (
	"net/url"
	"testing"

	"server/internal/modules/desktop"
)

func TestWindowSwitchCarriesConversationAndKeepsWatchOutOfRequestURL(t *testing.T) {
	shell := &windows{}
	handoff := &desktop.PetHandoff{CharacterID: "mao", ConversationID: "test & preview", WatchID: "capture-id"}
	pet, err := url.Parse(shell.switchURL(true, handoff))
	if err != nil {
		t.Fatal(err)
	}
	if query := pet.Query(); query.Get("pet") != "1" || query.Get("character") != "mao" ||
		query.Get("conversation") != handoff.ConversationID || query.Has("watch") || pet.Fragment != "watch=capture-id" {
		t.Fatalf("unexpected pet handoff: %s", pet)
	}
	back, err := url.Parse(shell.switchURL(false, handoff))
	if err != nil {
		t.Fatal(err)
	}
	if back.Query().Has("pet") || back.Fragment != "" || back.Query().Get("conversation") != handoff.ConversationID ||
		back.Query().Get("switch") == pet.Query().Get("switch") {
		t.Fatalf("unexpected workbench handoff: %s", back)
	}
}
