package actions

import (
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
)

func init() {
	Register(&StorageLvmListAction{})
	Register(&StorageBlockDevicesAction{})
	Register(&StorageFilesystemUsageAction{})
}

// ═══════════════════════════════════════════════════════════════
// storage.lvm_list : liste PV/VG/LV via pvs/vgs/lvs JSON
// ═══════════════════════════════════════════════════════════════

type StorageLvmListAction struct{}

func (a *StorageLvmListAction) ID() string                                 { return "storage.lvm_list" }
func (a *StorageLvmListAction) Capability() string                         { return "monitoring" }
func (a *StorageLvmListAction) Validate(_ map[string]interface{}) error    { return nil }

func (a *StorageLvmListAction) Execute(_ map[string]interface{}) (interface{}, error) {
	pvs := runLvmReport("pvs", "pv_name,vg_name,pv_size,pv_free,pv_used")
	vgs := runLvmReport("vgs", "vg_name,pv_count,lv_count,vg_size,vg_free")
	lvs := runLvmReport("lvs", "lv_name,vg_name,lv_size,lv_attr,lv_path")

	return map[string]interface{}{
		"pvs":       pvs,
		"vgs":       vgs,
		"lvs":       lvs,
		"available": len(pvs) > 0 || len(vgs) > 0 || len(lvs) > 0,
	}, nil
}

// runLvmReport retourne la liste des entries pour pvs/vgs/lvs.
// Si la commande echoue (LVM absent) on retourne une liste vide (pas d'erreur).
func runLvmReport(tool, fields string) []map[string]string {
	// --reportformat json, -o champs, --units b pour tailles normalisees en bytes
	cmd := exec.Command("sudo", "-n", "/usr/sbin/"+tool,
		"--reportformat", "json",
		"--units", "b",
		"--nosuffix",
		"-o", fields,
	)
	out, err := cmd.Output()
	if err != nil {
		return []map[string]string{}
	}
	// Structure: {"report":[{"pv":[{...}]}]} ou "vg"/"lv"
	var parsed struct {
		Report []map[string][]map[string]string `json:"report"`
	}
	if err := json.Unmarshal(out, &parsed); err != nil {
		return []map[string]string{}
	}
	if len(parsed.Report) == 0 {
		return []map[string]string{}
	}
	// Prendre la premiere cle trouvee (pv/vg/lv)
	for _, entries := range parsed.Report[0] {
		return entries
	}
	return []map[string]string{}
}

// ═══════════════════════════════════════════════════════════════
// storage.block_devices : lsblk -J
// ═══════════════════════════════════════════════════════════════

type StorageBlockDevicesAction struct{}

func (a *StorageBlockDevicesAction) ID() string                                 { return "storage.block_devices" }
func (a *StorageBlockDevicesAction) Capability() string                         { return "monitoring" }
func (a *StorageBlockDevicesAction) Validate(_ map[string]interface{}) error    { return nil }

func (a *StorageBlockDevicesAction) Execute(_ map[string]interface{}) (interface{}, error) {
	cmd := exec.Command("/usr/bin/lsblk", "-J", "-b",
		"-o", "NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT,MODEL,UUID,RO,RM")
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("lsblk failed: %w", err)
	}
	var parsed struct {
		Blockdevices []interface{} `json:"blockdevices"`
	}
	if err := json.Unmarshal(out, &parsed); err != nil {
		return nil, fmt.Errorf("failed to parse lsblk json: %w", err)
	}
	return map[string]interface{}{
		"devices": parsed.Blockdevices,
	}, nil
}

// ═══════════════════════════════════════════════════════════════
// storage.filesystem_usage : df -P (plus complet que les metrics)
// ═══════════════════════════════════════════════════════════════

type StorageFilesystemUsageAction struct{}

func (a *StorageFilesystemUsageAction) ID() string                                 { return "storage.filesystem_usage" }
func (a *StorageFilesystemUsageAction) Capability() string                         { return "monitoring" }
func (a *StorageFilesystemUsageAction) Validate(_ map[string]interface{}) error    { return nil }

func (a *StorageFilesystemUsageAction) Execute(_ map[string]interface{}) (interface{}, error) {
	// -x pour exclure les FS pseudo, -B1 pour bytes, -T pour type de FS
	cmd := exec.Command("/usr/bin/df", "-T", "-B1",
		"-x", "tmpfs", "-x", "devtmpfs", "-x", "overlay", "-x", "squashfs",
	)
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("df failed: %w", err)
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	if len(lines) < 2 {
		return map[string]interface{}{"filesystems": []interface{}{}}, nil
	}

	entries := make([]map[string]interface{}, 0, len(lines)-1)
	for _, line := range lines[1:] {
		fields := strings.Fields(line)
		if len(fields) < 7 {
			continue
		}
		entries = append(entries, map[string]interface{}{
			"device":     fields[0],
			"fstype":     fields[1],
			"size":       parseUint(fields[2]),
			"used":       parseUint(fields[3]),
			"available":  parseUint(fields[4]),
			"percent":    strings.TrimSuffix(fields[5], "%"),
			"mountpoint": strings.Join(fields[6:], " "),
		})
	}
	return map[string]interface{}{"filesystems": entries}, nil
}

func parseUint(s string) uint64 {
	var n uint64
	fmt.Sscanf(s, "%d", &n)
	return n
}
